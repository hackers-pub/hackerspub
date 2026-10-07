import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@hackerspub/models/passkey";
import type { Database, Transaction } from "@hackerspub/models/db";
import { passkeyTable } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";

/** Real ES256 WebAuthn fixture, including COSE EC2 key and none attestation. */
export function createWebAuthnCredential(origin = "http://localhost") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(16).toString("base64url");
  // COSE map: kty=EC2, alg=ES256, crv=P-256, x, y.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  function clientData(type: string, challenge: string, clientOrigin = origin) {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: clientOrigin,
        crossOrigin: false,
      }),
    );
  }
  return {
    id,
    async insert(db: Database | Transaction, accountId: Uuid) {
      await db.insert(passkeyTable).values({
        id,
        accountId,
        name: "Fixture",
        publicKey: cose,
        webauthnUserId: id,
        counter: 0n,
        deviceType: "multiDevice",
        backedUp: false,
        transports: ["internal"],
      });
    },
    assertion(
      challenge: string,
      flags = 5,
      clientOrigin = origin,
    ): AuthenticationResponseJSON {
      const data = clientData("webauthn.get", challenge, clientOrigin);
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([flags]),
        Buffer.alloc(4),
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(data).digest()]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
    registration(challenge: string): RegistrationResponseJSON {
      const credentialId = Buffer.from(id, "base64url");
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        credentialId,
        cose,
      ]);
      // CBOR {fmt:"none", attStmt:{}, authData:bytes}; authData fits uint16.
      const byteLength = Buffer.alloc(3);
      byteLength[0] = 0x59;
      byteLength.writeUInt16BE(authData.length, 1);
      const attestation = Buffer.concat([
        Buffer.from([0xa3, 0x63]),
        Buffer.from("fmt"),
        Buffer.from([0x64]),
        Buffer.from("none"),
        Buffer.from([0x67]),
        Buffer.from("attStmt"),
        Buffer.from([0xa0, 0x68]),
        Buffer.from("authData"),
        byteLength,
        authData,
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString(
            "base64url",
          ),
          attestationObject: attestation.toString("base64url"),
          transports: ["internal"],
        },
      };
    },
  };
}

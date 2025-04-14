import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { eq, sql } from "drizzle-orm";
import type Keyv from "keyv";
import { Buffer } from "node:buffer";
import type { Database } from "../db.ts";
import { ORIGIN } from "../federation/federation.ts";
import {
  type Account,
  type NewPasskey,
  type Passkey,
  passkeyTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const RP_NAME = "Hackers' Pub";
const RP_ID = new URL(ORIGIN).hostname;
const KV_NAMESPACE = "passkey";

export async function getRegistrationOptions(
  kv: Keyv,
  account: Account & { passkeys: Passkey[] },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: account.username,
    attestationType: "none",
    excludeCredentials: account.passkeys.map((passkey) => ({
      id: passkey.id,
      transports: passkey.transports ?? undefined,
    })),
  });
  await kv.set(`${KV_NAMESPACE}/registration/${account.id}`, options);
  return options;
}

export async function verifyRegistration(
  db: Database,
  kv: Keyv,
  account: Account,
  name: string,
  response: RegistrationResponseJSON,
): Promise<VerifiedRegistrationResponse> {
  const options = await kv.get<PublicKeyCredentialCreationOptionsJSON>(
    `${KV_NAMESPACE}/registration/${account.id}`,
  );
  if (options == null) {
    throw new Error(`Missing registration options for account ${account.id}.`);
  }
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (result.verified && result.registrationInfo != null) {
    const { credential, credentialDeviceType, credentialBackedUp } =
      result.registrationInfo;
    await db.insert(passkeyTable).values(
      {
        id: credential.id,
        accountId: account.id,
        name: name.trim(),
        publicKey: Buffer.from(credential.publicKey),
        webauthnUserId: options.user.id,
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports,
      } satisfies NewPasskey,
    );
  }
  return result;
}

export async function getAuthenticationOptions(
  kv: Keyv,
  sessionId: Uuid,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({ rpID: RP_ID });
  await kv.set(
    `${KV_NAMESPACE}/authentication/${sessionId}`,
    options,
    5 * 60 * 1000,
  );
  return options;
}

export async function verifyAuthentication(
  db: Database,
  kv: Keyv,
  sessionId: Uuid,
  response: AuthenticationResponseJSON,
): Promise<
  {
    response: VerifiedAuthenticationResponse;
    account: Account;
    passkey: Passkey & { account: Account };
  } | undefined
> {
  const options = await kv.get<PublicKeyCredentialCreationOptionsJSON>(
    `${KV_NAMESPACE}/authentication/${sessionId}`,
  );
  if (options == null) return undefined;
  const passkey = await db.query.passkeyTable.findFirst({
    where: { id: response.id },
    with: {
      account: true,
    },
  });
  if (passkey == null) return undefined;
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: response.id,
      publicKey: passkey.publicKey,
      counter: Number(passkey.counter),
      transports: passkey.transports ?? undefined,
    },
  });
  if (result.verified) {
    await db.update(passkeyTable)
      .set({
        counter: BigInt(result.authenticationInfo.newCounter),
        lastUsed: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(passkeyTable.id, response.id));
  }
  return { response: result, account: passkey.account, passkey };
}

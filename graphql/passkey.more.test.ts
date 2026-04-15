import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { passkeyTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const viewerPasskeysQuery = parse(`
  query ViewerPasskeys {
    viewer {
      passkeys(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`);

const verifyPasskeyRegistrationMutation = parse(`
  mutation VerifyPasskeyRegistration(
    $accountId: ID!
    $name: String!
    $registrationResponse: JSON!
  ) {
    verifyPasskeyRegistration(
      accountId: $accountId
      name: $name
      registrationResponse: $registrationResponse
    ) {
      verified
      passkey { id }
    }
  }
`);

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("Account.passkeys exposes the signed-in account's passkeys", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "passkeyviewer",
      name: "Passkey Viewer",
      email: "passkeyviewer@example.com",
    });
    await tx.insert(passkeyTable).values({
      id: "viewer-passkey",
      accountId: account.account.id,
      name: "Laptop",
      publicKey: Buffer.from([1, 2, 3]),
      webauthnUserId: "webauthn-user",
      counter: 0n,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal"],
    });

    const result = await execute({
      schema,
      document: viewerPasskeysQuery,
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      viewer: {
        passkeys: {
          edges: [{
            node: {
              id: encodeGlobalID("Passkey", "viewer-passkey"),
              name: "Laptop",
            },
          }],
        },
      },
    });
  });
});

test("verifyPasskeyRegistration requires authentication and a stored challenge", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "verifyregistrationowner",
      name: "Verify Registration Owner",
      email: "verifyregistrationowner@example.com",
    });
    const variables = {
      accountId: encodeGlobalID("Account", account.account.id),
      name: "Phone",
      registrationResponse: { id: "credential-id" },
    };

    const guestResult = await execute({
      schema,
      document: verifyPasskeyRegistrationMutation,
      variableValues: variables,
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(guestResult.data), {
      verifyPasskeyRegistration: null,
    });
    assert.equal(guestResult.errors?.[0].message, "Not authenticated.");

    const missingChallengeResult = await execute({
      schema,
      document: verifyPasskeyRegistrationMutation,
      variableValues: variables,
      contextValue: makeUserContext(tx, account.account, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(missingChallengeResult.data), {
      verifyPasskeyRegistration: null,
    });
    assert.equal(
      missingChallengeResult.errors?.[0].message,
      `Missing registration options for account ${account.account.id}.`,
    );
  });
});

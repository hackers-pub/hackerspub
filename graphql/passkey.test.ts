import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { Buffer } from "node:buffer";
import { passkeyTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const getRegistrationOptionsMutation = parse(`
  mutation GetPasskeyRegistrationOptions($accountId: ID!) {
    getPasskeyRegistrationOptions(accountId: $accountId)
  }
`);

const getAuthenticationOptionsMutation = parse(`
  mutation GetPasskeyAuthenticationOptions($sessionId: UUID!) {
    getPasskeyAuthenticationOptions(sessionId: $sessionId)
  }
`);

const loginByPasskeyMutation = parse(`
  mutation LoginByPasskey($sessionId: UUID!, $authenticationResponse: JSON!) {
    loginByPasskey(
      sessionId: $sessionId
      authenticationResponse: $authenticationResponse
    ) {
      __typename
      ... on Session {
        id
      }
      ... on AccountBannedError {
        since
      }
    }
  }
`);

const revokePasskeyMutation = parse(`
  mutation RevokePasskey($passkeyId: ID!) {
    revokePasskey(passkeyId: $passkeyId)
  }
`);

test(
  "getPasskeyRegistrationOptions stores a challenge for the signed-in account",
  async () => {
    await withRollback(async (tx) => {
      const { kv, store } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "passkeyowner",
        name: "Passkey Owner",
        email: "passkeyowner@example.com",
      });

      const result = await execute({
        schema,
        document: getRegistrationOptionsMutation,
        variableValues: {
          accountId: encodeGlobalID("Account", account.account.id),
        },
        contextValue: makeUserContext(tx, account.account, { kv }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);

      const options = (result.data as {
        getPasskeyRegistrationOptions: {
          challenge: string;
          user: { name: string };
        };
      }).getPasskeyRegistrationOptions;
      assert.ok(options.challenge.length > 0);
      assert.deepEqual(options.user.name, "passkeyowner");
      assert.ok(store.has(`passkey/registration/${account.account.id}`));
    });
  },
);

test(
  "getPasskeyAuthenticationOptions and loginByPasskey return null for unknown credentials",
  async () => {
    await withRollback(async (tx) => {
      const { kv, store } = createTestKv();
      const sessionId = generateUuidV7();

      const optionsResult = await execute({
        schema,
        document: getAuthenticationOptionsMutation,
        variableValues: { sessionId },
        contextValue: makeGuestContext(tx, { kv }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(optionsResult.errors, undefined);
      const options = (optionsResult.data as {
        getPasskeyAuthenticationOptions: { challenge: string };
      }).getPasskeyAuthenticationOptions;
      assert.ok(options.challenge.length > 0);
      assert.ok(store.has(`passkey/authentication/${sessionId}`));

      const loginResult = await execute({
        schema,
        document: loginByPasskeyMutation,
        variableValues: {
          sessionId,
          authenticationResponse: { id: "missing-passkey" },
        },
        contextValue: makeGuestContext(tx, { kv }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(loginResult.errors, undefined);
      assert.deepEqual(
        (loginResult.data as { loginByPasskey: null }).loginByPasskey,
        null,
      );
    });
  },
);

test(
  "revokePasskey deletes an existing passkey and returns its global ID",
  async () => {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "revokepasskeyowner",
        name: "Revoke Passkey Owner",
        email: "revokepasskeyowner@example.com",
      });

      await tx.insert(passkeyTable).values({
        id: "credential-id",
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
        document: revokePasskeyMutation,
        variableValues: {
          passkeyId: encodeGlobalID("Passkey", "credential-id"),
        },
        contextValue: makeUserContext(tx, account.account, { kv }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(
        (result.data as { revokePasskey: string | null }).revokePasskey,
        encodeGlobalID("Passkey", "credential-id"),
      );

      const stored = await tx.query.passkeyTable.findFirst({
        where: { id: "credential-id" },
      });
      assert.deepEqual(stored, undefined);
    });
  },
);

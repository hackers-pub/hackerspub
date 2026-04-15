import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const VALID_TOKEN = "0123456789abcdef".repeat(4);

const registerMutation = parse(`
  mutation RegisterApnsDeviceToken($deviceToken: String!) {
    registerApnsDeviceToken(input: { deviceToken: $deviceToken }) {
      __typename
      ... on RegisterApnsDeviceTokenPayload {
        deviceToken
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const unregisterMutation = parse(`
  mutation UnregisterApnsDeviceToken($deviceToken: String!) {
    unregisterApnsDeviceToken(input: { deviceToken: $deviceToken }) {
      __typename
      ... on UnregisterApnsDeviceTokenPayload {
        deviceToken
        unregistered
      }
    }
  }
`);

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("registerApnsDeviceToken rejects invalid device tokens", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlapnsinvalid",
      name: "GraphQL APNS Invalid",
      email: "graphqlapnsinvalid@example.com",
    });

    const result = await execute({
      schema,
      document: registerMutation,
      variableValues: { deviceToken: "invalid-token" },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      registerApnsDeviceToken: {
        __typename: "InvalidInputError",
        inputPath: "deviceToken",
      },
    });
  });
});

test("registerApnsDeviceToken and unregisterApnsDeviceToken round-trip through GraphQL", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlapnsowner",
      name: "GraphQL APNS Owner",
      email: "graphqlapnsowner@example.com",
    });

    const registerResult = await execute({
      schema,
      document: registerMutation,
      variableValues: { deviceToken: VALID_TOKEN.toUpperCase() },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(registerResult.errors, undefined);
    assert.deepEqual(toPlainJson(registerResult.data), {
      registerApnsDeviceToken: {
        __typename: "RegisterApnsDeviceTokenPayload",
        deviceToken: VALID_TOKEN,
      },
    });

    const unregisterResult = await execute({
      schema,
      document: unregisterMutation,
      variableValues: { deviceToken: VALID_TOKEN },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unregisterResult.errors, undefined);
    assert.deepEqual(toPlainJson(unregisterResult.data), {
      unregisterApnsDeviceToken: {
        __typename: "UnregisterApnsDeviceTokenPayload",
        deviceToken: VALID_TOKEN,
        unregistered: true,
      },
    });
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const validApnsToken = "0123456789abcdef".repeat(4);

const vapidKeyQuery = parse(`
  query WebPushVapidPublicKey {
    webPushVapidPublicKey
  }
`);

const registerMutation = parse(`
  mutation RegisterPushNotificationTarget(
    $input: RegisterPushNotificationTargetInput!
  ) {
    registerPushNotificationTarget(input: $input) {
      __typename
      ... on RegisterPushNotificationTargetPayload {
        service
        token
        endpoint
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const unregisterMutation = parse(`
  mutation UnregisterPushNotificationTarget(
    $input: UnregisterPushNotificationTargetInput!
  ) {
    unregisterPushNotificationTarget(input: $input) {
      __typename
      ... on UnregisterPushNotificationTargetPayload {
        service
        token
        endpoint
        unregistered
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

test("webPushVapidPublicKey returns configured public key or null", async () => {
  const originals = {
    publicKey: Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY"),
    privateKey: Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY"),
    subject: Deno.env.get("WEB_PUSH_VAPID_SUBJECT"),
  };
  try {
    await withRollback(async (tx) => {
      Deno.env.delete("WEB_PUSH_VAPID_PUBLIC_KEY");
      Deno.env.delete("WEB_PUSH_VAPID_PRIVATE_KEY");
      Deno.env.delete("WEB_PUSH_VAPID_SUBJECT");
      const missingResult = await execute({
        schema,
        document: vapidKeyQuery,
        contextValue: makeGuestContext(tx),
      });
      assert.equal(missingResult.errors, undefined);
      assert.deepEqual(toPlainJson(missingResult.data), {
        webPushVapidPublicKey: null,
      });

      Deno.env.set("WEB_PUSH_VAPID_PUBLIC_KEY", " test-vapid-key ");
      Deno.env.set("WEB_PUSH_VAPID_PRIVATE_KEY", " test-vapid-private-key ");
      Deno.env.set("WEB_PUSH_VAPID_SUBJECT", " mailto:test@example.com ");
      const configuredResult = await execute({
        schema,
        document: vapidKeyQuery,
        contextValue: makeGuestContext(tx),
      });
      assert.equal(configuredResult.errors, undefined);
      assert.deepEqual(toPlainJson(configuredResult.data), {
        webPushVapidPublicKey: "test-vapid-key",
      });
    });
  } finally {
    if (originals.publicKey == null) {
      Deno.env.delete("WEB_PUSH_VAPID_PUBLIC_KEY");
    } else {
      Deno.env.set("WEB_PUSH_VAPID_PUBLIC_KEY", originals.publicKey);
    }
    if (originals.privateKey == null) {
      Deno.env.delete("WEB_PUSH_VAPID_PRIVATE_KEY");
    } else {
      Deno.env.set("WEB_PUSH_VAPID_PRIVATE_KEY", originals.privateKey);
    }
    if (originals.subject == null) {
      Deno.env.delete("WEB_PUSH_VAPID_SUBJECT");
    } else {
      Deno.env.set("WEB_PUSH_VAPID_SUBJECT", originals.subject);
    }
  }
});

test("registerPushNotificationTarget rejects invalid APNS tokens", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushinvalid",
      name: "GraphQL Push Invalid",
      email: "graphqlpushinvalid@example.com",
    });

    const result = await execute({
      schema,
      document: registerMutation,
      variableValues: {
        input: {
          service: "APNS",
          token: "invalid-token",
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      registerPushNotificationTarget: {
        __typename: "InvalidInputError",
        inputPath: "token",
      },
    });
  });
});

test("registerPushNotificationTarget and unregisterPushNotificationTarget round-trip APNS tokens", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushapns",
      name: "GraphQL Push APNS",
      email: "graphqlpushapns@example.com",
    });

    const registerResult = await execute({
      schema,
      document: registerMutation,
      variableValues: {
        input: {
          service: "APNS",
          token: validApnsToken.toUpperCase(),
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(registerResult.errors, undefined);
    assert.deepEqual(toPlainJson(registerResult.data), {
      registerPushNotificationTarget: {
        __typename: "RegisterPushNotificationTargetPayload",
        service: "APNS",
        token: validApnsToken,
        endpoint: null,
      },
    });

    const unregisterResult = await execute({
      schema,
      document: unregisterMutation,
      variableValues: {
        input: {
          service: "APNS",
          token: validApnsToken,
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unregisterResult.errors, undefined);
    assert.deepEqual(toPlainJson(unregisterResult.data), {
      unregisterPushNotificationTarget: {
        __typename: "UnregisterPushNotificationTargetPayload",
        service: "APNS",
        token: validApnsToken,
        endpoint: null,
        unregistered: true,
      },
    });
  });
});

test("registerPushNotificationTarget and unregisterPushNotificationTarget round-trip Web Push endpoints", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushweb",
      name: "GraphQL Push Web",
      email: "graphqlpushweb@example.com",
    });
    const endpoint = "https://push.example/graphql/endpoint";

    const registerResult = await execute({
      schema,
      document: registerMutation,
      variableValues: {
        input: {
          service: "WEB_PUSH",
          endpoint,
          p256dh: "test-p256dh",
          auth: "test-auth",
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(registerResult.errors, undefined);
    assert.deepEqual(toPlainJson(registerResult.data), {
      registerPushNotificationTarget: {
        __typename: "RegisterPushNotificationTargetPayload",
        service: "WEB_PUSH",
        token: null,
        endpoint,
      },
    });

    const unregisterResult = await execute({
      schema,
      document: unregisterMutation,
      variableValues: {
        input: {
          service: "WEB_PUSH",
          endpoint,
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unregisterResult.errors, undefined);
    assert.deepEqual(toPlainJson(unregisterResult.data), {
      unregisterPushNotificationTarget: {
        __typename: "UnregisterPushNotificationTargetPayload",
        service: "WEB_PUSH",
        token: null,
        endpoint,
        unregistered: true,
      },
    });
  });
});

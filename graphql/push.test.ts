import assert from "node:assert/strict";
import test from "node:test";
import { clearWebPushEnvConfigCacheForTesting } from "@hackerspub/models/webpush";
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
const validWebPushP256dh =
  "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const validWebPushAuth = "AgICAgICAgICAgICAgICAg";

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

const deprecatedPushAliasesQuery = parse(`
  query DeprecatedPushAliases {
    __schema {
      mutationType {
        fields(includeDeprecated: true) {
          name
          isDeprecated
          deprecationReason
        }
      }
    }
  }
`);

const registerApnsAliasMutation = parse(`
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

const unregisterApnsAliasMutation = parse(`
  mutation UnregisterApnsDeviceToken($deviceToken: String!) {
    unregisterApnsDeviceToken(input: { deviceToken: $deviceToken }) {
      __typename
      ... on UnregisterApnsDeviceTokenPayload {
        deviceToken
        unregistered
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const registerFcmAliasMutation = parse(`
  mutation RegisterFcmDeviceToken($deviceToken: String!) {
    registerFcmDeviceToken(input: { deviceToken: $deviceToken }) {
      __typename
      ... on RegisterFcmDeviceTokenPayload {
        deviceToken
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const unregisterFcmAliasMutation = parse(`
  mutation UnregisterFcmDeviceToken($deviceToken: String!) {
    unregisterFcmDeviceToken(input: { deviceToken: $deviceToken }) {
      __typename
      ... on UnregisterFcmDeviceTokenPayload {
        deviceToken
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
      clearWebPushEnvConfigCacheForTesting();
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
      clearWebPushEnvConfigCacheForTesting();
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
    clearWebPushEnvConfigCacheForTesting();
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

test("registerPushNotificationTarget rejects unsafe Web Push subscriptions", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushwebinvalid",
      name: "GraphQL Push Web Invalid",
      email: "graphqlpushwebinvalid@example.com",
    });

    for (
      const [input, inputPath] of [
        [{
          service: "WEB_PUSH",
          endpoint: "https://127.0.0.1/push",
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
        }, "endpoint"],
        [{
          service: "WEB_PUSH",
          endpoint: "https://[::ffff:169.254.169.254]/push",
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
        }, "endpoint"],
        [{
          service: "WEB_PUSH",
          endpoint: "https://push.example/endpoint",
          p256dh: "@@",
          auth: validWebPushAuth,
        }, "p256dh"],
        [{
          service: "WEB_PUSH",
          endpoint: "https://push.example/endpoint",
          p256dh: "dG9vLXNob3J0",
          auth: validWebPushAuth,
        }, "p256dh"],
        [{
          service: "WEB_PUSH",
          endpoint: "https://push.example/endpoint",
          p256dh: validWebPushP256dh,
          auth: "@@",
        }, "auth"],
        [{
          service: "WEB_PUSH",
          endpoint: "https://push.example/endpoint",
          p256dh: validWebPushP256dh,
          auth: "dG9vLXNob3J0",
        }, "auth"],
      ] as const
    ) {
      const result = await execute({
        schema,
        document: registerMutation,
        variableValues: { input },
        contextValue: makeUserContext(tx, account.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        registerPushNotificationTarget: {
          __typename: "InvalidInputError",
          inputPath,
        },
      });
    }
  });
});

test("unregisterPushNotificationTarget rejects malformed identifiers", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushunregisterinvalid",
      name: "GraphQL Push Unregister Invalid",
      email: "graphqlpushunregisterinvalid@example.com",
    });

    for (
      const [input, inputPath] of [
        [{ service: "APNS", token: "invalid-token" }, "token"],
        [{ service: "FCM", token: "  " }, "token"],
        [{ service: "WEB_PUSH", endpoint: "  " }, "endpoint"],
      ] as const
    ) {
      const result = await execute({
        schema,
        document: unregisterMutation,
        variableValues: { input },
        contextValue: makeUserContext(tx, account.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        unregisterPushNotificationTarget: {
          __typename: "InvalidInputError",
          inputPath,
        },
      });
    }
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
          p256dh: validWebPushP256dh,
          auth: validWebPushAuth,
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

test("legacy APNS and FCM mutations remain available but deprecated", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: deprecatedPushAliasesQuery,
      contextValue: makeGuestContext(tx),
    });

    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      __schema: {
        mutationType: {
          fields: {
            name: string;
            isDeprecated: boolean;
            deprecationReason: string | null;
          }[];
        };
      };
    };
    const fields = data.__schema.mutationType.fields;
    const byName = new Map(fields.map((field) => [field.name, field]));

    assert.deepEqual(byName.get("registerApnsDeviceToken"), {
      name: "registerApnsDeviceToken",
      isDeprecated: true,
      deprecationReason:
        "Use `registerPushNotificationTarget` with `service: APNS` instead.",
    });
    assert.deepEqual(byName.get("unregisterApnsDeviceToken"), {
      name: "unregisterApnsDeviceToken",
      isDeprecated: true,
      deprecationReason:
        "Use `unregisterPushNotificationTarget` with `service: APNS` instead.",
    });
    assert.deepEqual(byName.get("registerFcmDeviceToken"), {
      name: "registerFcmDeviceToken",
      isDeprecated: true,
      deprecationReason:
        "Use `registerPushNotificationTarget` with `service: FCM` instead.",
    });
    assert.deepEqual(byName.get("unregisterFcmDeviceToken"), {
      name: "unregisterFcmDeviceToken",
      isDeprecated: true,
      deprecationReason:
        "Use `unregisterPushNotificationTarget` with `service: FCM` instead.",
    });
  });
});

test("legacy APNS mutation aliases round-trip device tokens", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushapnsalias",
      name: "GraphQL Push APNS Alias",
      email: "graphqlpushapnsalias@example.com",
    });

    const registerResult = await execute({
      schema,
      document: registerApnsAliasMutation,
      variableValues: { deviceToken: `<${validApnsToken.toUpperCase()}>` },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(registerResult.errors, undefined);
    assert.deepEqual(toPlainJson(registerResult.data), {
      registerApnsDeviceToken: {
        __typename: "RegisterApnsDeviceTokenPayload",
        deviceToken: validApnsToken,
      },
    });

    const unregisterResult = await execute({
      schema,
      document: unregisterApnsAliasMutation,
      variableValues: { deviceToken: validApnsToken },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unregisterResult.errors, undefined);
    assert.deepEqual(toPlainJson(unregisterResult.data), {
      unregisterApnsDeviceToken: {
        __typename: "UnregisterApnsDeviceTokenPayload",
        deviceToken: validApnsToken,
        unregistered: true,
      },
    });
  });
});

test("legacy FCM mutation aliases round-trip device tokens", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlpushfcmalias",
      name: "GraphQL Push FCM Alias",
      email: "graphqlpushfcmalias@example.com",
    });
    const fcmToken = "fcm-token-alias";

    const registerResult = await execute({
      schema,
      document: registerFcmAliasMutation,
      variableValues: { deviceToken: ` ${fcmToken} ` },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(registerResult.errors, undefined);
    assert.deepEqual(toPlainJson(registerResult.data), {
      registerFcmDeviceToken: {
        __typename: "RegisterFcmDeviceTokenPayload",
        deviceToken: fcmToken,
      },
    });

    const unregisterResult = await execute({
      schema,
      document: unregisterFcmAliasMutation,
      variableValues: { deviceToken: fcmToken },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(unregisterResult.errors, undefined);
    assert.deepEqual(toPlainJson(unregisterResult.data), {
      unregisterFcmDeviceToken: {
        __typename: "UnregisterFcmDeviceTokenPayload",
        deviceToken: fcmToken,
        unregistered: true,
      },
    });
  });
});

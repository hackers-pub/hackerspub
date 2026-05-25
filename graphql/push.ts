import type {
  PushNotificationPreviewPolicy as PreviewPolicy,
  PushNotificationService as Service,
} from "@hackerspub/models/schema";
import {
  normalizeApnsDeviceToken,
  normalizeFcmDeviceToken,
  normalizeWebPushEndpoint,
  normalizeWebPushKey,
  registerPushNotificationTarget,
  unregisterPushNotificationTarget,
} from "@hackerspub/models/push";
import { getWebPushVapidPublicKey } from "@hackerspub/models/webpush";
import { assertNever } from "@std/assert/unstable-never";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

export const PushNotificationService = builder.enumType(
  "PushNotificationService",
  {
    description:
      "Push delivery service for a registered notification target. Use " +
      "`WEB_PUSH` for browser Push API subscriptions.",
    values: {
      APNS: {
        description:
          "Apple Push Notification service target used by iOS clients.",
      },
      FCM: {
        description: "Firebase Cloud Messaging target used by Android clients.",
      },
      WEB_PUSH: {
        description:
          "Browser Push API subscription delivered with the Web Push protocol.",
      },
    } as const,
  },
);

export const PushNotificationPreviewPolicy = builder.enumType(
  "PushNotificationPreviewPolicy",
  {
    description:
      "Controls how much post content may be included in push notification " +
      "payloads. Payloads can be displayed on a lock screen and pass through " +
      "third-party push services.",
    values: {
      PUBLIC_ONLY: {
        description:
          "Include a short preview only for non-sensitive `PUBLIC` or " +
          "`UNLISTED` posts. Other notifications use generic copy.",
      },
      ALL: {
        description:
          "Include a short preview whenever the notification has post content, " +
          "including restricted or sensitive posts.",
      },
      NONE: {
        description:
          "Never include post content previews in push notification payloads.",
      },
    } as const,
  },
);

export function toPushNotificationService(
  service: Service,
): typeof PushNotificationService.$inferType {
  return service === "apns"
    ? "APNS"
    : service === "fcm"
    ? "FCM"
    : service === "web_push"
    ? "WEB_PUSH"
    : assertNever(service, `Invalid \`PushNotificationService\`: "${service}"`);
}

function fromPushNotificationService(
  service: typeof PushNotificationService.$inferType,
): Service {
  return service === "APNS"
    ? "apns"
    : service === "FCM"
    ? "fcm"
    : service === "WEB_PUSH"
    ? "web_push"
    : assertNever(service, `Invalid \`PushNotificationService\`: "${service}"`);
}

export function toPushNotificationPreviewPolicy(
  policy: PreviewPolicy,
): typeof PushNotificationPreviewPolicy.$inferType {
  return policy === "public_only"
    ? "PUBLIC_ONLY"
    : policy === "all"
    ? "ALL"
    : policy === "none"
    ? "NONE"
    : assertNever(
      policy,
      `Invalid \`PushNotificationPreviewPolicy\`: "${policy}"`,
    );
}

export function fromPushNotificationPreviewPolicy(
  policy: typeof PushNotificationPreviewPolicy.$inferType,
): PreviewPolicy {
  return policy === "PUBLIC_ONLY"
    ? "public_only"
    : policy === "ALL"
    ? "all"
    : policy === "NONE"
    ? "none"
    : assertNever(
      policy,
      `Invalid \`PushNotificationPreviewPolicy\`: "${policy}"`,
    );
}

builder.queryField("webPushVapidPublicKey", (t) =>
  t.string({
    nullable: true,
    description:
      "URL-safe Base64 VAPID public key for browser Push API subscriptions. " +
      "Returns `null` when Web Push delivery is not configured on the server.",
    resolve() {
      return getWebPushVapidPublicKey();
    },
  }));

builder.relayMutationField(
  "registerPushNotificationTarget",
  {
    description:
      "Register or refresh a push notification target for the authenticated " +
      "viewer. `APNS` and `FCM` require `token`; `WEB_PUSH` requires " +
      "`endpoint`, `p256dh`, and `auth` from the browser `PushSubscription`.",
    inputFields: (t) => ({
      service: t.field({
        type: PushNotificationService,
        required: true,
        description: "Push service that owns the target.",
      }),
      token: t.string({
        required: false,
        description:
          "Device token for `APNS` or `FCM`. Must be omitted for `WEB_PUSH`.",
      }),
      endpoint: t.string({
        required: false,
        description:
          "Browser push service endpoint from `PushSubscription.endpoint`. " +
          "Required for `WEB_PUSH` and omitted otherwise.",
      }),
      p256dh: t.string({
        required: false,
        description:
          "URL-safe Base64 `p256dh` encryption key from `PushSubscription`.",
      }),
      auth: t.string({
        required: false,
        description: "URL-safe Base64 `auth` secret from `PushSubscription`.",
      }),
      expirationTime: t.field({
        type: "DateTime",
        required: false,
        description:
          "Optional browser subscription expiration time. `null` means the " +
          "browser did not provide an expiration.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
      ],
      union: {
        description:
          "Result of registering a push notification target. Successful " +
          "responses return the stored target; invalid input and " +
          "authentication failures are returned as typed errors.",
      },
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();

      const service = fromPushNotificationService(args.input.service);
      let endpoint = args.input.endpoint;
      let p256dh = args.input.p256dh;
      let auth = args.input.auth;
      if (service === "web_push") {
        if (
          endpoint == null ||
          p256dh == null ||
          auth == null ||
          args.input.token != null
        ) {
          throw new InvalidInputError("service");
        }
        endpoint = normalizeWebPushEndpoint(endpoint);
        if (endpoint == null) {
          throw new InvalidInputError("endpoint");
        }
        p256dh = normalizeWebPushKey(p256dh);
        if (p256dh == null) {
          throw new InvalidInputError("p256dh");
        }
        auth = normalizeWebPushKey(auth);
        if (auth == null) {
          throw new InvalidInputError("auth");
        }
      } else if (
        args.input.token == null ||
        endpoint != null ||
        p256dh != null ||
        auth != null ||
        args.input.expirationTime != null
      ) {
        throw new InvalidInputError("service");
      } else if (
        service === "apns" && normalizeApnsDeviceToken(args.input.token) == null
      ) {
        throw new InvalidInputError("token");
      } else if (
        service === "fcm" && normalizeFcmDeviceToken(args.input.token) == null
      ) {
        throw new InvalidInputError("token");
      }

      const result = await registerPushNotificationTarget(
        ctx.db,
        session.accountId,
        {
          service,
          token: args.input.token,
          subscription: service === "web_push"
            ? {
              endpoint: endpoint!,
              p256dh: p256dh!,
              auth: auth!,
              expirationTime: args.input.expirationTime,
            }
            : null,
        },
      );
      if (result == null) {
        throw new InvalidInputError("service");
      }
      return result;
    },
  },
  {
    description:
      "Successful response for `registerPushNotificationTarget`. Contains " +
      "the normalized `token` or `endpoint` that was stored.",
    outputFields: (t) => ({
      service: t.field({
        type: PushNotificationService,
        description: "Push service for the registered target.",
        resolve(result) {
          return toPushNotificationService(result.service);
        },
      }),
      token: t.string({
        nullable: true,
        description:
          "`APNS` or `FCM` device token. `null` for browser Web Push targets.",
        resolve(result) {
          return result.token;
        },
      }),
      endpoint: t.string({
        nullable: true,
        description:
          "Browser Push API endpoint. `null` for APNS and FCM targets.",
        resolve(result) {
          return result.endpoint;
        },
      }),
      created: t.field({
        type: "DateTime",
        description: "When this target was first registered.",
        resolve(result) {
          return result.created;
        },
      }),
      updated: t.field({
        type: "DateTime",
        description:
          "When this target was last refreshed or reassigned to an account.",
        resolve(result) {
          return result.updated;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unregisterPushNotificationTarget",
  {
    description:
      "Remove a push notification target owned by the authenticated viewer. " +
      "`APNS` and `FCM` identify targets by `token`; `WEB_PUSH` identifies " +
      "targets by `endpoint`.",
    inputFields: (t) => ({
      service: t.field({
        type: PushNotificationService,
        required: true,
        description: "Push service that owns the target.",
      }),
      token: t.string({
        required: false,
        description:
          "Device token for `APNS` or `FCM`. Must be omitted for `WEB_PUSH`.",
      }),
      endpoint: t.string({
        required: false,
        description:
          "Browser push service endpoint for `WEB_PUSH`. Must be omitted " +
          "for `APNS` and `FCM`.",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
      union: {
        description:
          "Result of unregistering a push notification target. Successful " +
          "responses report whether a matching target was removed; invalid " +
          "input and authentication failures are returned as typed errors.",
      },
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();

      const service = fromPushNotificationService(args.input.service);
      let token = args.input.token;
      let endpoint = args.input.endpoint;
      if (service === "web_push") {
        if (endpoint == null || token != null) {
          throw new InvalidInputError("service");
        }
        endpoint = endpoint.trim();
        if (endpoint === "") throw new InvalidInputError("endpoint");
      } else if (token == null || endpoint != null) {
        throw new InvalidInputError("service");
      } else if (service === "apns") {
        token = normalizeApnsDeviceToken(token);
        if (token == null) throw new InvalidInputError("token");
      } else if (service === "fcm") {
        token = normalizeFcmDeviceToken(token);
        if (token == null) throw new InvalidInputError("token");
      }

      const unregistered = await unregisterPushNotificationTarget(
        ctx.db,
        session.accountId,
        {
          service,
          token,
          endpoint,
        },
      );
      return {
        service,
        token,
        endpoint,
        unregistered,
      };
    },
  },
  {
    description:
      "Successful response for `unregisterPushNotificationTarget`. " +
      "Identifies the target requested for removal and whether it was owned " +
      "by the viewer.",
    outputFields: (t) => ({
      service: t.field({
        type: PushNotificationService,
        description: "Push service for the requested target.",
        resolve(result) {
          return toPushNotificationService(result.service);
        },
      }),
      token: t.string({
        nullable: true,
        description: "`APNS` or `FCM` device token requested for removal.",
        resolve(result) {
          return result.token ?? null;
        },
      }),
      endpoint: t.string({
        nullable: true,
        description: "`WEB_PUSH` endpoint requested for removal.",
        resolve(result) {
          return result.endpoint ?? null;
        },
      }),
      unregistered: t.boolean({
        description:
          "`true` when an owned target was deleted. `false` when the target " +
          "did not exist or belonged to a different account.",
        resolve(result) {
          return result.unregistered;
        },
      }),
    }),
  },
);

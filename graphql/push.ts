import type {
  PushNotificationPreviewPolicy as PreviewPolicy,
  PushNotificationService as Service,
} from "@hackerspub/models/schema";
import {
  MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE,
  normalizeApnsDeviceToken,
  normalizeFcmDeviceToken,
  registerPushNotificationTarget,
  unregisterPushNotificationTarget,
} from "@hackerspub/models/push";
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

class RegisterPushNotificationTargetFailedError extends Error {
  public constructor(
    public readonly limit: number = MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE,
  ) {
    super(`Cannot register more than ${limit} push notification targets.`);
  }
}

builder.objectType(RegisterPushNotificationTargetFailedError, {
  name: "RegisterPushNotificationTargetFailedError",
  description:
    "Returned when a push notification target cannot be registered after " +
    "validating the input. The most common cause is a per-service device " +
    "limit.",
  fields: (t) => ({
    message: t.expose("message", {
      type: "String",
      description: "Human-readable explanation of the registration failure.",
    }),
    limit: t.exposeInt("limit", {
      description:
        "Maximum number of targets this account may register for one service.",
    }),
  }),
});

builder.queryField("webPushVapidPublicKey", (t) =>
  t.string({
    nullable: true,
    description:
      "URL-safe Base64 VAPID public key for browser Push API subscriptions. " +
      "Returns `null` when Web Push delivery is not configured on the server.",
    resolve() {
      return Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY")?.trim() || null;
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
        RegisterPushNotificationTargetFailedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();

      const service = fromPushNotificationService(args.input.service);
      if (service === "web_push") {
        if (
          args.input.endpoint == null ||
          args.input.p256dh == null ||
          args.input.auth == null ||
          args.input.token != null
        ) {
          throw new InvalidInputError("service");
        }
        if (args.input.endpoint.trim() === "") {
          throw new InvalidInputError("endpoint");
        }
        if (args.input.p256dh.trim() === "") {
          throw new InvalidInputError("p256dh");
        }
        if (args.input.auth.trim() === "") {
          throw new InvalidInputError("auth");
        }
      } else if (
        args.input.token == null ||
        args.input.endpoint != null ||
        args.input.p256dh != null ||
        args.input.auth != null ||
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
              endpoint: args.input.endpoint!,
              p256dh: args.input.p256dh!,
              auth: args.input.auth!,
              expirationTime: args.input.expirationTime,
            }
            : null,
        },
      );
      if (result == null) {
        throw new RegisterPushNotificationTargetFailedError();
      }
      return result;
    },
  },
  {
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
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();

      const service = fromPushNotificationService(args.input.service);
      if (service === "web_push") {
        if (args.input.endpoint == null || args.input.token != null) {
          throw new InvalidInputError("service");
        }
      } else if (args.input.token == null || args.input.endpoint != null) {
        throw new InvalidInputError("service");
      }

      const unregistered = await unregisterPushNotificationTarget(
        ctx.db,
        session.accountId,
        {
          service,
          token: args.input.token,
          endpoint: args.input.endpoint,
        },
      );
      return {
        service,
        token: args.input.token,
        endpoint: args.input.endpoint,
        unregistered,
      };
    },
  },
  {
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

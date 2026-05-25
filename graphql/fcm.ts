import {
  MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT,
  normalizeFcmDeviceToken,
  registerFcmDeviceToken,
  unregisterFcmDeviceToken,
} from "@hackerspub/models/fcm";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

const REGISTER_DEPRECATION_REASON =
  "Use `registerPushNotificationTarget` with `service: FCM` instead.";
const UNREGISTER_DEPRECATION_REASON =
  "Use `unregisterPushNotificationTarget` with `service: FCM` instead.";

class RegisterFcmDeviceTokenFailedError extends Error {
  public constructor(
    public readonly limit: number = MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT,
  ) {
    super(`Cannot register more than ${limit} FCM device tokens.`);
  }
}

builder.objectType(RegisterFcmDeviceTokenFailedError, {
  name: "RegisterFcmDeviceTokenFailedError",
  description:
    "Returned by the deprecated FCM registration mutation when the token " +
    "could not be stored. New clients should use the unified push target " +
    "mutation instead.",
  fields: (t) => ({
    message: t.expose("message", {
      type: "String",
      description:
        "Human-readable explanation of the FCM registration failure.",
    }),
    limit: t.exposeInt("limit", {
      description:
        "Maximum number of FCM device tokens this account may register.",
    }),
  }),
});

builder.relayMutationField(
  "registerFcmDeviceToken",
  {
    description: "Legacy input for registering an FCM device token. Use " +
      "`RegisterPushNotificationTargetInput` for new clients.",
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description:
          "FCM registration token. Surrounding whitespace is trimmed.",
      }),
    }),
  },
  {
    description:
      "Deprecated FCM-only registration mutation kept for existing Android " +
      "clients. New clients should call `registerPushNotificationTarget`.",
    deprecationReason: REGISTER_DEPRECATION_REASON,
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        RegisterFcmDeviceTokenFailedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const trimmed = normalizeFcmDeviceToken(args.input.deviceToken);
      if (trimmed == null) throw new InvalidInputError("deviceToken");
      const result = await registerFcmDeviceToken(
        ctx.db,
        session.accountId,
        trimmed,
      );
      if (result == null) {
        throw new RegisterFcmDeviceTokenFailedError();
      }
      return result;
    },
  },
  {
    description:
      "Legacy FCM registration payload. New clients should read the unified " +
      "`RegisterPushNotificationTargetPayload` fields instead.",
    outputFields: (t) => ({
      deviceToken: t.string({
        description: "Trimmed FCM registration token that was registered.",
        resolve(result) {
          return result.token!;
        },
      }),
      created: t.field({
        type: "DateTime",
        description: "When this FCM token was first registered.",
        resolve(result) {
          return result.created;
        },
      }),
      updated: t.field({
        type: "DateTime",
        description: "When this FCM token was last refreshed.",
        resolve(result) {
          return result.updated;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unregisterFcmDeviceToken",
  {
    description: "Legacy input for unregistering an FCM device token. Use " +
      "`UnregisterPushNotificationTargetInput` for new clients.",
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description:
          "FCM registration token. Surrounding whitespace is trimmed.",
      }),
    }),
  },
  {
    description:
      "Deprecated FCM-only unregister mutation kept for existing Android " +
      "clients. New clients should call `unregisterPushNotificationTarget`.",
    deprecationReason: UNREGISTER_DEPRECATION_REASON,
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const trimmed = normalizeFcmDeviceToken(args.input.deviceToken);
      if (trimmed == null) throw new InvalidInputError("deviceToken");
      const unregistered = await unregisterFcmDeviceToken(
        ctx.db,
        session.accountId,
        trimmed,
      );
      return {
        deviceToken: trimmed,
        unregistered,
      };
    },
  },
  {
    description:
      "Legacy FCM unregister payload. New clients should read the unified " +
      "`UnregisterPushNotificationTargetPayload` fields instead.",
    outputFields: (t) => ({
      deviceToken: t.string({
        description: "Trimmed FCM registration token requested for removal.",
        resolve(result) {
          return result.deviceToken;
        },
      }),
      unregistered: t.boolean({
        description:
          "`true` when an owned FCM token was deleted. `false` when the " +
          "token did not exist or belonged to another account.",
        resolve(result) {
          return result.unregistered;
        },
      }),
    }),
  },
);

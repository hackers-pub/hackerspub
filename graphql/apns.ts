import {
  MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT,
  normalizeApnsDeviceToken,
  registerApnsDeviceToken,
  unregisterApnsDeviceToken,
} from "@hackerspub/models/apns";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

const REGISTER_DEPRECATION_REASON =
  "Use `registerPushNotificationTarget` with `service: APNS` instead.";
const UNREGISTER_DEPRECATION_REASON =
  "Use `unregisterPushNotificationTarget` with `service: APNS` instead.";

class RegisterApnsDeviceTokenFailedError extends Error {
  public constructor(
    public readonly limit: number = MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT,
  ) {
    super(`Cannot register more than ${limit} APNS device tokens.`);
  }
}

builder.objectType(RegisterApnsDeviceTokenFailedError, {
  name: "RegisterApnsDeviceTokenFailedError",
  description:
    "Returned by the deprecated APNS registration mutation when the token " +
    "could not be stored. New clients should use the unified push target " +
    "mutation instead.",
  fields: (t) => ({
    message: t.expose("message", {
      type: "String",
      description:
        "Human-readable explanation of the APNS registration failure.",
    }),
    limit: t.exposeInt("limit", {
      description:
        "Maximum number of APNS device tokens this account may register.",
    }),
  }),
});

builder.relayMutationField(
  "registerApnsDeviceToken",
  {
    description: "Legacy input for registering an APNS device token. Use " +
      "`RegisterPushNotificationTargetInput` for new clients.",
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description:
          "APNS device token. Hex tokens are normalized before storage.",
      }),
    }),
  },
  {
    description:
      "Deprecated APNS-only registration mutation kept for existing iOS " +
      "clients. New clients should call `registerPushNotificationTarget`.",
    deprecationReason: REGISTER_DEPRECATION_REASON,
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        RegisterApnsDeviceTokenFailedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const normalized = normalizeApnsDeviceToken(args.input.deviceToken);
      if (normalized == null) throw new InvalidInputError("deviceToken");
      const result = await registerApnsDeviceToken(
        ctx.db,
        session.accountId,
        normalized,
      );
      if (result == null) {
        throw new RegisterApnsDeviceTokenFailedError();
      }
      return result;
    },
  },
  {
    description:
      "Legacy APNS registration payload. New clients should read the unified " +
      "`RegisterPushNotificationTargetPayload` fields instead.",
    outputFields: (t) => ({
      deviceToken: t.string({
        description: "Normalized APNS device token that was registered.",
        resolve(result) {
          return result.token!;
        },
      }),
      created: t.field({
        type: "DateTime",
        description: "When this APNS token was first registered.",
        resolve(result) {
          return result.created;
        },
      }),
      updated: t.field({
        type: "DateTime",
        description: "When this APNS token was last refreshed.",
        resolve(result) {
          return result.updated;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unregisterApnsDeviceToken",
  {
    description: "Legacy input for unregistering an APNS device token. Use " +
      "`UnregisterPushNotificationTargetInput` for new clients.",
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description:
          "APNS device token. Hex tokens are normalized before removal.",
      }),
    }),
  },
  {
    description:
      "Deprecated APNS-only unregister mutation kept for existing iOS " +
      "clients. New clients should call `unregisterPushNotificationTarget`.",
    deprecationReason: UNREGISTER_DEPRECATION_REASON,
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const normalized = normalizeApnsDeviceToken(args.input.deviceToken);
      if (normalized == null) throw new InvalidInputError("deviceToken");
      const unregistered = await unregisterApnsDeviceToken(
        ctx.db,
        session.accountId,
        normalized,
      );
      return {
        deviceToken: normalized,
        unregistered,
      };
    },
  },
  {
    description:
      "Legacy APNS unregister payload. New clients should read the unified " +
      "`UnregisterPushNotificationTargetPayload` fields instead.",
    outputFields: (t) => ({
      deviceToken: t.string({
        description: "Normalized APNS device token requested for removal.",
        resolve(result) {
          return result.deviceToken;
        },
      }),
      unregistered: t.boolean({
        description:
          "`true` when an owned APNS token was deleted. `false` when the " +
          "token did not exist or belonged to another account.",
        resolve(result) {
          return result.unregistered;
        },
      }),
    }),
  },
);

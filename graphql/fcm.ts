import {
  MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT,
  registerFcmDeviceToken,
  unregisterFcmDeviceToken,
} from "@hackerspub/models/fcm";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

class RegisterFcmDeviceTokenFailedError extends Error {
  public constructor(
    public readonly limit: number = MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT,
  ) {
    super(`Cannot register more than ${limit} FCM device tokens.`);
  }
}

builder.objectType(RegisterFcmDeviceTokenFailedError, {
  name: "RegisterFcmDeviceTokenFailedError",
  fields: (t) => ({
    message: t.expose("message", { type: "String" }),
    limit: t.exposeInt("limit"),
  }),
});

builder.relayMutationField(
  "registerFcmDeviceToken",
  {
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description: "The FCM device token.",
      }),
    }),
  },
  {
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
      const trimmed = args.input.deviceToken.trim();
      if (trimmed.length < 1) {
        throw new InvalidInputError("deviceToken");
      }
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
    outputFields: (t) => ({
      deviceToken: t.string({
        resolve(result) {
          return result.deviceToken;
        },
      }),
      created: t.field({
        type: "DateTime",
        resolve(result) {
          return result.created;
        },
      }),
      updated: t.field({
        type: "DateTime",
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
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description: "The FCM device token.",
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
      const trimmed = args.input.deviceToken.trim();
      if (trimmed.length < 1) throw new InvalidInputError("deviceToken");
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
    outputFields: (t) => ({
      deviceToken: t.string({
        resolve(result) {
          return result.deviceToken;
        },
      }),
      unregistered: t.boolean({
        resolve(result) {
          return result.unregistered;
        },
      }),
    }),
  },
);

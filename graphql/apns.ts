import {
  MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT,
  normalizeApnsDeviceToken,
  registerApnsDeviceToken,
  unregisterApnsDeviceToken,
} from "@hackerspub/models/apns";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

class RegisterApnsDeviceTokenFailedError extends Error {
  public constructor(
    public readonly limit: number = MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT,
  ) {
    super(`Cannot register more than ${limit} APNS device tokens.`);
  }
}

builder.objectType(RegisterApnsDeviceTokenFailedError, {
  name: "RegisterApnsDeviceTokenFailedError",
  fields: (t) => ({
    message: t.expose("message", { type: "String" }),
    limit: t.exposeInt("limit"),
  }),
});

builder.relayMutationField(
  "registerApnsDeviceToken",
  {
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description: "The APNS device token.",
      }),
    }),
  },
  {
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
  "unregisterApnsDeviceToken",
  {
    inputFields: (t) => ({
      deviceToken: t.string({
        required: true,
        description: "The APNS device token.",
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

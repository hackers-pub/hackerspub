import {
  normalizeApnsDeviceToken,
  registerApnsDeviceToken,
  unregisterApnsDeviceToken,
} from "@hackerspub/models/apns";
import { builder } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

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
      types: [NotAuthenticatedError, InvalidInputError],
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
        throw new Error("Failed to register APNS device token.");
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

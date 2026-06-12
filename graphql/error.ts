import { ActorSuspendedError } from "@hackerspub/models/moderation";
import { builder } from "./builder.ts";

builder.objectType(ActorSuspendedError, {
  name: "ActorSuspendedError",
  description:
    "Returned by write mutations (posting, reacting, sharing, following, " +
    "voting) when the authenticated account is under an active moderation " +
    "suspension.  Suspension only restricts writing; reading still works. " +
    "Check `suspendedUntil` to tell a temporary suspension (a timestamp) " +
    "from a permanent one (`null`).",
  fields: (t) => ({
    suspendedUntil: t.expose("suspendedUntil", {
      type: "DateTime",
      nullable: true,
      description:
        "When the suspension ends, or `null` for a permanent suspension.",
    }),
  }),
});

export { ActorSuspendedError };

export class InvalidInputError extends Error {
  public constructor(public readonly inputPath: string) {
    super(`Invalid input - ${inputPath}`);
  }
}

builder.objectType(InvalidInputError, {
  name: "InvalidInputError",
  fields: (t) => ({
    inputPath: t.expose("inputPath", { type: "String" }),
  }),
});

export class NotAuthorizedError extends Error {
  public constructor() {
    super("Not authorized");
  }
}

builder.objectType(NotAuthorizedError, {
  name: "NotAuthorizedError",
  fields: (t) => ({
    notAuthorized: t.string({
      resolve: () => "",
    }),
  }),
});

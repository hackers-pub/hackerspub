import {
  getRelaySubscription,
  getRelaySubscriptions,
  subscribeRelay,
  unsubscribeRelay,
} from "@hackerspub/models/relay";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { builder } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { lookupActorByUrl, parseHttpUrl } from "./lookup.ts";
import { NotAuthenticatedError } from "./session.ts";

export const RelaySubscription = builder.drizzleNode("relaySubscriptionTable", {
  name: "RelaySubscription",
  description:
    "A subscription that makes this instance's instance actor follow an " +
    "ActivityPub relay, so the relay forwards public posts to this instance. " +
    "Created via `subscribeRelay` and removed via `unsubscribeRelay`. Only " +
    "moderators can read `RelaySubscription` values; it is purely server " +
    "(instance) state and is not tied to any user account.",
  authScopes: { moderator: true },
  // Run the moderator scope when the node itself is resolved (not just lazily
  // per field), so a non-moderator cannot even confirm a `RelaySubscription`
  // exists via `node(id) { __typename }`.
  runScopesOnType: true,
  id: {
    column: (subscription) => subscription.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The subscription's row UUID.",
    }),
    actor: t.relation("actor", {
      description:
        "The relay `Actor` this instance is subscribed to (always a remote " +
        "actor, never a local account).",
    }),
    accepted: t.expose("accepted", {
      type: "DateTime",
      nullable: true,
      description:
        "When the relay accepted this instance's `Follow` (its `Accept` " +
        "arrived), or `null` while the subscription is still pending. A " +
        "relay only forwards posts once it has accepted.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When this subscription was created (the `Follow` sent).",
    }),
  }),
});

builder.queryField("relaySubscriptions", (t) =>
  t.field({
    type: [RelaySubscription],
    nullable: true,
    description:
      "Moderator-only list of ActivityPub relays this instance is subscribed " +
      "to, newest first. Returns `null` when the viewer is not a moderator; " +
      "routes should guard with `viewer.moderator`.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return await getRelaySubscriptions(ctx.db);
    },
  }),
);

builder.mutationField("subscribeRelay", (t) =>
  t.field({
    type: RelaySubscription,
    description:
      "Subscribe this instance's instance actor to an ActivityPub relay by " +
      "its actor URL (the `Follow`'s `object` is the relay actor itself). " +
      "Requires a moderator account. The relay actor is resolved (and " +
      "persisted) via ActivityPub if not already known. Idempotent: " +
      "subscribing to an already-subscribed relay returns the existing " +
      "subscription. Raises `InvalidInputError` (`actorUrl`) when the URL " +
      "does not resolve to a remote actor (a local actor cannot be a relay).",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      actorUrl: t.arg({
        type: "URL",
        required: true,
        description:
          "The relay actor's URL, e.g. `https://relay.example/actor`.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const parsed = parseHttpUrl(args.actorUrl.toString());
      if (parsed == null) throw new InvalidInputError("actorUrl");
      const relayActor = await lookupActorByUrl(ctx, parsed);
      // A local actor (one backed by an account on this instance) cannot be a
      // relay, so reject it the same way as an unresolvable URL.
      if (relayActor == null || relayActor.accountId != null) {
        throw new InvalidInputError("actorUrl");
      }
      await subscribeRelay(ctx.fedCtx, relayActor);
      const subscription = await ctx.db.query.relaySubscriptionTable.findFirst({
        with: { actor: { with: { instance: true } } },
        where: { actorId: relayActor.id },
      });
      if (subscription == null) throw new InvalidInputError("actorUrl");
      return subscription;
    },
  }),
);

const UnsubscribeRelayPayload = builder.simpleObject(
  "UnsubscribeRelayPayload",
  {
    description: "The result of removing a relay subscription.",
    fields: (t) => ({
      relaySubscriptionId: t.id({
        description:
          "The global id of the removed `RelaySubscription`, so clients can " +
          "evict it from their cache.",
      }),
    }),
  },
);

builder.mutationField("unsubscribeRelay", (t) =>
  t.field({
    type: UnsubscribeRelayPayload,
    nullable: true,
    description:
      "Unsubscribe this instance's instance actor from a relay (sends an " +
      "`Undo` of the original `Follow` and removes the subscription). " +
      "Requires a moderator account. Returns the removed subscription's " +
      "global id, or `null` when no subscription has that id.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    args: {
      id: t.arg.globalID({
        for: RelaySubscription,
        required: true,
        description: "The `RelaySubscription`'s global id.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      if (!validateUuid(args.id.id)) return null;
      const subscription = await getRelaySubscription(
        ctx.db,
        args.id.id as Uuid,
      );
      if (subscription == null) return null;
      await unsubscribeRelay(ctx.fedCtx, subscription);
      return {
        relaySubscriptionId: encodeGlobalID(
          RelaySubscription.name,
          subscription.id,
        ),
      };
    },
  }),
);

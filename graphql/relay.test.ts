import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import type { Transaction } from "@hackerspub/models/db";
import { getRelaySubscription } from "@hackerspub/models/relay";
import {
  accountTable,
  relaySubscriptionTable,
} from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  insertAccountWithActor,
  insertRemoteActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

async function makeModerator(
  tx: Transaction,
  values: { username: string; name: string; email: string },
): Promise<AuthenticatedAccount> {
  const { account } = await insertAccountWithActor(tx, values);
  await tx.update(accountTable).set({ moderator: true }).where(
    eq(accountTable.id, account.id),
  );
  return { ...account, moderator: true };
}

async function seedRelay(tx: Transaction, host = "relay.example") {
  const relay = await insertRemoteActor(tx, {
    username: "relay",
    name: "Example Relay",
    host,
    iri: `https://${host}/actor`,
    type: "Application",
  });
  return relay;
}

const relaySubscriptionsQuery = parse(`
  query RelaySubscriptions {
    relaySubscriptions {
      uuid
      accepted
      actor { iri handle }
    }
  }
`);

const relaySubscriptionNodeQuery = parse(`
  query RelaySubscriptionNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on RelaySubscription { uuid }
    }
  }
`);

const subscribeRelayMutation = parse(`
  mutation SubscribeRelay($actorUrl: URL!) {
    subscribeRelay(actorUrl: $actorUrl) {
      __typename
      ... on RelaySubscription {
        uuid
        accepted
        actor { iri }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);

const unsubscribeRelayMutation = parse(`
  mutation UnsubscribeRelay($id: ID!) {
    unsubscribeRelay(id: $id) {
      __typename
      ... on UnsubscribeRelayPayload { relaySubscriptionId }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

Deno.test({
  name: "relaySubscriptions is null for guests and non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      await tx.insert(relaySubscriptionTable).values({
        id: generateUuidV7(),
        actorId: relay.id,
        followIri: "https://hackers.pub/relay-follow/1",
      });
      const { account } = await insertAccountWithActor(tx, {
        username: "plain",
        name: "Plain",
        email: "plain@example.com",
      });

      const guest = await execute({
        schema,
        document: relaySubscriptionsQuery,
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guest.errors, undefined);
      assertEquals(
        (guest.data as { relaySubscriptions: unknown }).relaySubscriptions,
        null,
      );

      const nonMod = await execute({
        schema,
        document: relaySubscriptionsQuery,
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(nonMod.errors, undefined);
      assertEquals(
        (nonMod.data as { relaySubscriptions: unknown }).relaySubscriptions,
        null,
      );
    });
  },
});

Deno.test({
  name: "relaySubscriptions lists subscriptions for moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      await tx.insert(relaySubscriptionTable).values({
        id: generateUuidV7(),
        actorId: relay.id,
        followIri: "https://hackers.pub/relay-follow/1",
      });
      const moderator = await makeModerator(tx, {
        username: "mod",
        name: "Mod",
        email: "mod@example.com",
      });

      const result = await execute({
        schema,
        document: relaySubscriptionsQuery,
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const list = (result.data as {
        relaySubscriptions: { actor: { iri: string; handle: string } }[];
      }).relaySubscriptions;
      assertEquals(list.length, 1);
      assertEquals(list[0].actor.iri, relay.iri);
      assertEquals(list[0].actor.handle, "@relay@relay.example");
    });
  },
});

Deno.test({
  name: "RelaySubscription node is not resolvable by non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      const subscriptionId = generateUuidV7() as Uuid;
      await tx.insert(relaySubscriptionTable).values({
        id: subscriptionId,
        actorId: relay.id,
        followIri: "https://hackers.pub/relay-follow/1",
      });
      const gid = encodeGlobalID("RelaySubscription", subscriptionId);
      const moderator = await makeModerator(tx, {
        username: "mod",
        name: "Mod",
        email: "mod@example.com",
      });
      const { account } = await insertAccountWithActor(tx, {
        username: "plain",
        name: "Plain",
        email: "plain@example.com",
      });

      // A moderator can resolve the node.
      const modResult = await execute({
        schema,
        document: relaySubscriptionNodeQuery,
        variableValues: { id: gid },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(modResult.errors, undefined);
      assertEquals(
        (modResult.data as { node: { __typename: string; uuid: string } })
          .node.__typename,
        "RelaySubscription",
      );

      // A non-moderator must not even learn the node exists: `node` resolves
      // to `null` and no `RelaySubscription` data leaks.
      const nonModResult = await execute({
        schema,
        document: relaySubscriptionNodeQuery,
        variableValues: { id: gid },
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (nonModResult.data as { node: unknown } | null)?.node ?? null,
        null,
      );

      // A guest likewise gets nothing.
      const guestResult = await execute({
        schema,
        document: relaySubscriptionNodeQuery,
        variableValues: { id: gid },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (guestResult.data as { node: unknown } | null)?.node ?? null,
        null,
      );
    });
  },
});

Deno.test({
  name: "subscribeRelay rejects guests and non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      const { account } = await insertAccountWithActor(tx, {
        username: "plain",
        name: "Plain",
        email: "plain@example.com",
      });

      const guest = await execute({
        schema,
        document: subscribeRelayMutation,
        variableValues: { actorUrl: relay.iri },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guest.errors, undefined);
      assertEquals(
        (guest.data as { subscribeRelay: { __typename: string } })
          .subscribeRelay.__typename,
        "NotAuthenticatedError",
      );

      const nonMod = await execute({
        schema,
        document: subscribeRelayMutation,
        variableValues: { actorUrl: relay.iri },
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(nonMod.errors, undefined);
      assertEquals(
        (nonMod.data as { subscribeRelay: { __typename: string } })
          .subscribeRelay.__typename,
        "NotAuthorizedError",
      );
    });
  },
});

Deno.test({
  name: "subscribeRelay subscribes a moderator to a known relay actor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      const moderator = await makeModerator(tx, {
        username: "mod",
        name: "Mod",
        email: "mod@example.com",
      });

      const result = await execute({
        schema,
        document: subscribeRelayMutation,
        variableValues: { actorUrl: relay.iri },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const payload = (result.data as {
        subscribeRelay: {
          __typename: string;
          accepted: string | null;
          actor: { iri: string };
        };
      }).subscribeRelay;
      assertEquals(payload.__typename, "RelaySubscription");
      assertEquals(payload.accepted, null);
      assertEquals(payload.actor.iri, relay.iri);

      const row = await tx.query.relaySubscriptionTable.findFirst({
        where: { actorId: relay.id },
      });
      assert(row != null);
    });
  },
});

Deno.test({
  name: "subscribeRelay rejects a local actor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx, {
        username: "mod",
        name: "Mod",
        email: "mod@example.com",
      });
      const local = await insertAccountWithActor(tx, {
        username: "localuser",
        name: "Local User",
        email: "localuser@example.com",
      });

      const result = await execute({
        schema,
        document: subscribeRelayMutation,
        variableValues: { actorUrl: local.actor.iri },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const payload = (result.data as {
        subscribeRelay: { __typename: string; inputPath?: string };
      }).subscribeRelay;
      assertEquals(payload.__typename, "InvalidInputError");
      assertEquals(payload.inputPath, "actorUrl");
    });
  },
});

Deno.test({
  name: "unsubscribeRelay removes a subscription for a moderator",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      const subscriptionId = generateUuidV7() as Uuid;
      await tx.insert(relaySubscriptionTable).values({
        id: subscriptionId,
        actorId: relay.id,
        followIri: "https://hackers.pub/relay-follow/1",
      });
      const moderator = await makeModerator(tx, {
        username: "mod",
        name: "Mod",
        email: "mod@example.com",
      });

      const result = await execute({
        schema,
        document: unsubscribeRelayMutation,
        variableValues: {
          id: encodeGlobalID("RelaySubscription", subscriptionId),
        },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const payload = (result.data as {
        unsubscribeRelay: { __typename: string; relaySubscriptionId: string };
      }).unsubscribeRelay;
      assertEquals(payload.__typename, "UnsubscribeRelayPayload");
      assertEquals(
        payload.relaySubscriptionId,
        encodeGlobalID("RelaySubscription", subscriptionId),
      );
      assertEquals(await getRelaySubscription(tx, subscriptionId), undefined);
    });
  },
});

Deno.test({
  name: "unsubscribeRelay rejects non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await seedRelay(tx);
      const subscriptionId = generateUuidV7() as Uuid;
      await tx.insert(relaySubscriptionTable).values({
        id: subscriptionId,
        actorId: relay.id,
        followIri: "https://hackers.pub/relay-follow/1",
      });
      const { account } = await insertAccountWithActor(tx, {
        username: "plain",
        name: "Plain",
        email: "plain@example.com",
      });

      const result = await execute({
        schema,
        document: unsubscribeRelayMutation,
        variableValues: {
          id: encodeGlobalID("RelaySubscription", subscriptionId),
        },
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as { unsubscribeRelay: { __typename: string } })
          .unsubscribeRelay.__typename,
        "NotAuthorizedError",
      );
      // The subscription must survive a rejected unsubscribe.
      assert(await getRelaySubscription(tx, subscriptionId) != null);
    });
  },
});

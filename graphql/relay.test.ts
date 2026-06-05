import assert from "node:assert/strict";
import test from "node:test";
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

test("relaySubscriptions is null for guests and non-moderators", async () => {
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
    assert.deepEqual(guest.errors, undefined);
    assert.deepEqual(
      (guest.data as { relaySubscriptions: unknown }).relaySubscriptions,
      null,
    );

    const nonMod = await execute({
      schema,
      document: relaySubscriptionsQuery,
      contextValue: makeUserContext(tx, account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(nonMod.errors, undefined);
    assert.deepEqual(
      (nonMod.data as { relaySubscriptions: unknown }).relaySubscriptions,
      null,
    );
  });
});

test("relaySubscriptions lists subscriptions for moderators", async () => {
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
    assert.deepEqual(result.errors, undefined);
    const list = (result.data as {
      relaySubscriptions: { actor: { iri: string; handle: string } }[];
    }).relaySubscriptions;
    assert.deepEqual(list.length, 1);
    assert.deepEqual(list[0].actor.iri, relay.iri);
    assert.deepEqual(list[0].actor.handle, "@relay@relay.example");
  });
});

test("RelaySubscription node is not resolvable by non-moderators", async () => {
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
    assert.deepEqual(modResult.errors, undefined);
    assert.deepEqual(
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
    assert.deepEqual(
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
    assert.deepEqual(
      (guestResult.data as { node: unknown } | null)?.node ?? null,
      null,
    );
  });
});

test("subscribeRelay rejects guests and non-moderators", async () => {
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
    assert.deepEqual(guest.errors, undefined);
    assert.deepEqual(
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
    assert.deepEqual(nonMod.errors, undefined);
    assert.deepEqual(
      (nonMod.data as { subscribeRelay: { __typename: string } })
        .subscribeRelay.__typename,
      "NotAuthorizedError",
    );
  });
});

test("subscribeRelay subscribes a moderator to a known relay actor", async () => {
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
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      subscribeRelay: {
        __typename: string;
        accepted: string | null;
        actor: { iri: string };
      };
    }).subscribeRelay;
    assert.deepEqual(payload.__typename, "RelaySubscription");
    assert.deepEqual(payload.accepted, null);
    assert.deepEqual(payload.actor.iri, relay.iri);

    const row = await tx.query.relaySubscriptionTable.findFirst({
      where: { actorId: relay.id },
    });
    assert.ok(row != null);
  });
});

test("subscribeRelay rejects a local actor", async () => {
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
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      subscribeRelay: { __typename: string; inputPath?: string };
    }).subscribeRelay;
    assert.deepEqual(payload.__typename, "InvalidInputError");
    assert.deepEqual(payload.inputPath, "actorUrl");
  });
});

test("unsubscribeRelay removes a subscription for a moderator", async () => {
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
    assert.deepEqual(result.errors, undefined);
    const payload = (result.data as {
      unsubscribeRelay: { __typename: string; relaySubscriptionId: string };
    }).unsubscribeRelay;
    assert.deepEqual(payload.__typename, "UnsubscribeRelayPayload");
    assert.deepEqual(
      payload.relaySubscriptionId,
      encodeGlobalID("RelaySubscription", subscriptionId),
    );
    assert.deepEqual(await getRelaySubscription(tx, subscriptionId), undefined);
  });
});

test("unsubscribeRelay rejects non-moderators", async () => {
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
    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as { unsubscribeRelay: { __typename: string } })
        .unsubscribeRelay.__typename,
      "NotAuthorizedError",
    );
    // The subscription must survive a rejected unsubscribe.
    assert.ok(await getRelaySubscription(tx, subscriptionId) != null);
  });
});

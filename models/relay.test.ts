import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { assertRejects } from "@std/assert/rejects";
import { Follow, Undo } from "@fedify/vocab";
import type { RequestContext } from "@fedify/fedify";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";
import type { ContextData } from "./context.ts";
import { relaySubscriptionTable } from "./schema.ts";
import {
  getRelayFollowIri,
  getRelaySubscription,
  getRelaySubscriptions,
  markRelaySubscriptionAccepted,
  removeRelaySubscription,
  subscribeRelay,
  unsubscribeRelay,
} from "./relay.ts";

interface SentActivity {
  recipient: unknown;
  activity: unknown;
}

function withCapturingFedCtx(
  tx: Parameters<typeof createFedCtx>[0],
): {
  fedCtx: RequestContext<ContextData>;
  sent: SentActivity[];
} {
  const fedCtx = createFedCtx(tx);
  const sent: SentActivity[] = [];
  // deno-lint-ignore no-explicit-any
  (fedCtx as any).sendActivity = (
    _sender: unknown,
    recipient: unknown,
    activity: unknown,
  ) => {
    sent.push({ recipient, activity });
    return Promise.resolve(undefined);
  };
  return { fedCtx, sent };
}

Deno.test({
  name: "subscribeRelay sends a Follow to the relay actor and records the row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        inboxUrl: "https://relay.example/inbox",
        type: "Application",
      });

      const { fedCtx, sent } = withCapturingFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);

      assert(subscription != null);
      assertEquals(subscription.actorId, relay.id);
      assertEquals(subscription.accepted, null);
      assertEquals(
        subscription.followIri,
        getRelayFollowIri(fedCtx, subscription.id).href,
      );

      const stored = await tx.query.relaySubscriptionTable.findFirst({
        where: { id: subscription.id },
      });
      assert(stored != null);
      assertEquals(stored.actorId, relay.id);

      // A Follow whose object is the relay actor itself was dispatched from the
      // instance actor.
      assertEquals(sent.length, 1);
      const activity = sent[0].activity;
      assert(activity instanceof Follow);
      assertEquals(activity.objectId?.href, relay.iri);
      assertEquals(activity.id?.href, subscription.followIri);
      assertEquals(
        activity.actorId?.href,
        fedCtx.getActorUri("localhost").href,
      );
    });
  },
});

Deno.test({
  name: "subscribeRelay re-sends a pending Follow without duplicating the row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        type: "Application",
      });

      const { fedCtx, sent } = withCapturingFedCtx(tx);
      const first = await subscribeRelay(fedCtx, relay);
      assert(first != null);

      // Re-subscribing while still pending re-sends the same Follow and returns
      // the existing subscription instead of leaving it stuck pending.
      const second = await subscribeRelay(fedCtx, relay);
      assert(second != null);
      assertEquals(second.id, first.id);
      assertEquals(second.followIri, first.followIri);
      assertEquals(sent.length, 2);

      const rows = await tx.select().from(relaySubscriptionTable).where(
        eq(relaySubscriptionTable.actorId, relay.id),
      );
      assertEquals(rows.length, 1);

      // Once the relay has accepted, re-subscribing is a no-op: no extra row
      // and no extra Follow.
      await markRelaySubscriptionAccepted(tx, first.followIri, relay.iri);
      const third = await subscribeRelay(fedCtx, relay);
      assertEquals(third, undefined);
      assertEquals(sent.length, 2);
    });
  },
});

Deno.test({
  name:
    "getRelaySubscriptions returns subscriptions newest first with the actor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const older = await insertRemoteActor(tx, {
        username: "old",
        name: "Old Relay",
        host: "old.example",
        iri: "https://old.example/actor",
        type: "Application",
      });
      const newer = await insertRemoteActor(tx, {
        username: "new",
        name: "New Relay",
        host: "new.example",
        iri: "https://new.example/actor",
        type: "Application",
      });

      await tx.insert(relaySubscriptionTable).values({
        id: crypto.randomUUID(),
        actorId: older.id,
        followIri: "https://hackers.pub/relay-follow/1",
        created: new Date("2026-01-01T00:00:00Z"),
      });
      await tx.insert(relaySubscriptionTable).values({
        id: crypto.randomUUID(),
        actorId: newer.id,
        followIri: "https://hackers.pub/relay-follow/2",
        created: new Date("2026-02-01T00:00:00Z"),
      });

      // Filter to this test's own relays so the assertion is independent of
      // any other relay subscriptions already in the database; the relative
      // order (newest first) is preserved by the filter.
      const subscriptions = (await getRelaySubscriptions(tx)).filter(
        (s) => s.actor.iri === newer.iri || s.actor.iri === older.iri,
      );
      assertEquals(subscriptions.length, 2);
      assertEquals(subscriptions[0].actor.iri, newer.iri);
      assertEquals(subscriptions[1].actor.iri, older.iri);
      assert(subscriptions[0].actor.instance != null);
    });
  },
});

Deno.test({
  name:
    "markRelaySubscriptionAccepted flips accepted only for the matching relay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        type: "Application",
      });
      const { fedCtx } = withCapturingFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      // A mismatched relay IRI must not accept the subscription.
      const mismatch = await markRelaySubscriptionAccepted(
        tx,
        subscription.followIri,
        "https://evil.example/actor",
      );
      assertEquals(mismatch, undefined);
      const stillPending = await getRelaySubscription(tx, subscription.id);
      assertEquals(stillPending?.accepted, null);

      const accepted = await markRelaySubscriptionAccepted(
        tx,
        subscription.followIri,
        relay.iri,
      );
      assert(accepted != null);
      // The returned row must reflect the acceptance, not the stale pre-update
      // state.
      assert(accepted.accepted != null);
      const reloaded = await getRelaySubscription(tx, subscription.id);
      assert(reloaded?.accepted != null);

      // A second Accept is idempotent: it returns the still-accepted row and
      // keeps the original acceptance timestamp.
      const reaccepted = await markRelaySubscriptionAccepted(
        tx,
        subscription.followIri,
        relay.iri,
      );
      assert(reaccepted?.accepted != null);
      assertEquals(
        reaccepted.accepted.getTime(),
        reloaded.accepted.getTime(),
      );
    });
  },
});

Deno.test({
  name: "removeRelaySubscription deletes only for the matching relay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        type: "Application",
      });
      const { fedCtx } = withCapturingFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const mismatch = await removeRelaySubscription(
        tx,
        subscription.followIri,
        "https://evil.example/actor",
      );
      assertEquals(mismatch, undefined);
      assert(await getRelaySubscription(tx, subscription.id) != null);

      const removed = await removeRelaySubscription(
        tx,
        subscription.followIri,
        relay.iri,
      );
      assert(removed != null);
      assertEquals(await getRelaySubscription(tx, subscription.id), undefined);
    });
  },
});

Deno.test({
  name: "unsubscribeRelay sends an Undo and deletes the row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        inboxUrl: "https://relay.example/inbox",
        type: "Application",
      });
      const { fedCtx, sent } = withCapturingFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const loaded = await getRelaySubscription(tx, subscription.id);
      assert(loaded != null);
      const removed = await unsubscribeRelay(fedCtx, loaded);
      assert(removed != null);
      // The Undo is dispatched (after the subscribe Follow, before the delete).
      assertEquals(sent.length, 2);
      assert(sent[1].activity instanceof Undo);
      assertEquals(await getRelaySubscription(tx, subscription.id), undefined);
    });
  },
});

Deno.test({
  name: "unsubscribeRelay keeps the row when the Undo fails to send",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const relay = await insertRemoteActor(tx, {
        username: "relay",
        name: "Example Relay",
        host: "relay.example",
        iri: "https://relay.example/actor",
        inboxUrl: "https://relay.example/inbox",
        type: "Application",
      });
      const { fedCtx } = withCapturingFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);
      const loaded = await getRelaySubscription(tx, subscription.id);
      assert(loaded != null);

      // Mutations run in autocommit, so a failed Undo send must leave the row
      // in place to be retried rather than dropping it.
      // deno-lint-ignore no-explicit-any
      (fedCtx as any).sendActivity = () =>
        Promise.reject(new Error("queue unavailable"));
      await assertRejects(() => unsubscribeRelay(fedCtx, loaded));
      assert(await getRelaySubscription(tx, subscription.id) != null);
    });
  },
});

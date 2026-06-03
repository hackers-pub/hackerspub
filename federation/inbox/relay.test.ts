import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import type { InboxContext } from "@fedify/fedify";
import { Accept, Follow, Reject } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { getRelaySubscription, subscribeRelay } from "@hackerspub/models/relay";
import {
  createFedCtx,
  insertRemoteActor,
  withRollback,
} from "../../test/postgres.ts";
import { onRelayFollowAccepted, onRelayFollowRejected } from "./relay.ts";

function asInboxContext(
  ctx: ReturnType<typeof createFedCtx>,
): InboxContext<ContextData> {
  return ctx as unknown as InboxContext<ContextData>;
}

Deno.test({
  name: "onRelayFollowAccepted marks the matching subscription accepted",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const accept = new Accept({
        actor: new URL(relay.iri),
        object: new URL(subscription.followIri),
      });
      const handled = await onRelayFollowAccepted(
        asInboxContext(fedCtx),
        accept,
      );
      assertEquals(handled, true);

      const reloaded = await getRelaySubscription(tx, subscription.id);
      assert(reloaded?.accepted != null);
    });
  },
});

Deno.test({
  name: "onRelayFollowAccepted handles an Accept with an embedded Follow",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      // Many relays echo the whole Follow activity inside the Accept rather
      // than just its IRI; Fedify still exposes the embedded Follow's id
      // through `accept.objectId`, so the handler matches it.
      const accept = new Accept({
        actor: new URL(relay.iri),
        object: new Follow({
          id: new URL(subscription.followIri),
          actor: fedCtx.getActorUri("localhost"),
          object: new URL(relay.iri),
        }),
      });
      const handled = await onRelayFollowAccepted(
        asInboxContext(fedCtx),
        accept,
      );
      assertEquals(handled, true);

      const reloaded = await getRelaySubscription(tx, subscription.id);
      assert(reloaded?.accepted != null);
    });
  },
});

Deno.test({
  name: "onRelayFollowRejected handles a Reject with an embedded Follow",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const reject = new Reject({
        actor: new URL(relay.iri),
        object: new Follow({
          id: new URL(subscription.followIri),
          actor: fedCtx.getActorUri("localhost"),
          object: new URL(relay.iri),
        }),
      });
      const handled = await onRelayFollowRejected(
        asInboxContext(fedCtx),
        reject,
      );
      assertEquals(handled, true);
      assertEquals(await getRelaySubscription(tx, subscription.id), undefined);
    });
  },
});

Deno.test({
  name: "onRelayFollowAccepted ignores a forged Accept from another actor",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const accept = new Accept({
        actor: new URL("https://evil.example/actor"),
        object: new URL(subscription.followIri),
      });
      const handled = await onRelayFollowAccepted(
        asInboxContext(fedCtx),
        accept,
      );
      assertEquals(handled, false);

      const reloaded = await getRelaySubscription(tx, subscription.id);
      assertEquals(reloaded?.accepted, null);
    });
  },
});

Deno.test({
  name: "onRelayFollowAccepted ignores an Accept with no matching subscription",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      // A user-follow Accept (not a relay follow) must not be claimed here.
      const accept = new Accept({
        actor: new URL("https://remote.example/users/bob"),
        object: new Follow({
          id: new URL("https://hackers.pub/ap/actors/u#follow/123"),
          actor: new URL("https://hackers.pub/ap/actors/u"),
          object: new URL("https://remote.example/users/bob"),
        }),
      });
      const handled = await onRelayFollowAccepted(
        asInboxContext(fedCtx),
        accept,
      );
      assertEquals(handled, false);
    });
  },
});

Deno.test({
  name: "onRelayFollowRejected removes the matching subscription",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const reject = new Reject({
        actor: new URL(relay.iri),
        object: new URL(subscription.followIri),
      });
      const handled = await onRelayFollowRejected(
        asInboxContext(fedCtx),
        reject,
      );
      assertEquals(handled, true);
      assertEquals(await getRelaySubscription(tx, subscription.id), undefined);
    });
  },
});

Deno.test({
  name: "onRelayFollowRejected ignores a forged Reject from another actor",
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
      const fedCtx = createFedCtx(tx);
      const subscription = await subscribeRelay(fedCtx, relay);
      assert(subscription != null);

      const reject = new Reject({
        actor: new URL("https://evil.example/actor"),
        object: new URL(subscription.followIri),
      });
      const handled = await onRelayFollowRejected(
        asInboxContext(fedCtx),
        reject,
      );
      assertEquals(handled, false);
      assert(await getRelaySubscription(tx, subscription.id) != null);
    });
  },
});

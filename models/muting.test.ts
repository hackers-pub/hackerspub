import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { getMutedActorIds, mute, unmute } from "./muting.ts";
import {
  createReplyNotification,
  createShareNotification,
} from "./notification.ts";
import { followingTable, mutingTable } from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  seedLocalInstance,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "mute() creates a muting row and is idempotent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const muter = await insertAccountWithActor(tx, {
        username: "muter",
        name: "Muter",
        email: "muter@example.com",
      });
      const mutee = await insertAccountWithActor(tx, {
        username: "mutee",
        name: "Mutee",
        email: "mutee@example.com",
      });

      const created = await mute(tx, muter.account, mutee.actor);
      assert(created != null);

      const again = await mute(tx, muter.account, mutee.actor);
      assert(again != null);
      assertEquals(again.id, created.id);

      const rows = await tx.select().from(mutingTable).where(
        and(
          eq(mutingTable.muterId, muter.actor.id),
          eq(mutingTable.muteeId, mutee.actor.id),
        ),
      );
      assertEquals(rows.length, 1);
    });
  },
});

Deno.test({
  name: "unmute() deletes the muting row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const muter = await insertAccountWithActor(tx, {
        username: "unmuter",
        name: "Unmuter",
        email: "unmuter@example.com",
      });
      const mutee = await insertAccountWithActor(tx, {
        username: "unmutee",
        name: "Unmutee",
        email: "unmutee@example.com",
      });

      await mute(tx, muter.account, mutee.actor);
      const removed = await unmute(tx, muter.account, mutee.actor);
      assert(removed != null);

      const remaining = await tx.select().from(mutingTable).where(
        and(
          eq(mutingTable.muterId, muter.actor.id),
          eq(mutingTable.muteeId, mutee.actor.id),
        ),
      );
      assertEquals(remaining, []);
    });
  },
});

Deno.test({
  name: "unmute() returns undefined when no mute exists",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const muter = await insertAccountWithActor(tx, {
        username: "noopmuter",
        name: "Noop Muter",
        email: "noopmuter@example.com",
      });
      const mutee = await insertAccountWithActor(tx, {
        username: "noopmutee",
        name: "Noop Mutee",
        email: "noopmutee@example.com",
      });

      const removed = await unmute(tx, muter.account, mutee.actor);
      assertEquals(removed, undefined);
    });
  },
});

Deno.test({
  name: "getMutedActorIds returns the subset that the muter has muted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      await seedLocalInstance(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const muter = await insertAccountWithActor(tx, {
        username: `gmaimuter${suffix}`,
        name: "GMAI Muter",
        email: `gmaimuter-${suffix}@example.com`,
      });
      const muted = await insertAccountWithActor(tx, {
        username: `gmaimuted${suffix}`,
        name: "GMAI Muted",
        email: `gmaimuted-${suffix}@example.com`,
      });
      const notMuted = await insertAccountWithActor(tx, {
        username: `gmainotmuted${suffix}`,
        name: "GMAI Not Muted",
        email: `gmainotmuted-${suffix}@example.com`,
      });

      await mute(tx, muter.account, muted.actor);

      const result = await getMutedActorIds(tx, muter.actor.id, [
        muted.actor.id,
        notMuted.actor.id,
        generateUuidV7() as Uuid,
      ]);

      assertEquals(result.has(muted.actor.id), true);
      assertEquals(result.has(notMuted.actor.id), false);
      assertEquals(result.size, 1);
    });
  },
});

Deno.test({
  name: "getMutedActorIds returns empty for empty input",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const result = await getMutedActorIds(tx, generateUuidV7() as Uuid, []);
      assertEquals(result.size, 0);
    });
  },
});

Deno.test({
  name: "createNotification suppresses notifications from a muted actor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "mutenotifyrecipient",
        name: "Recipient",
        email: "mutenotifyrecipient@example.com",
      });
      const replier = await insertAccountWithActor(tx, {
        username: "mutenotifyreplier",
        name: "Replier",
        email: "mutenotifyreplier@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: recipient.account,
        content: "Original",
      });

      await mute(tx, recipient.account, replier.actor);

      const suppressed = await createReplyNotification(
        tx,
        recipient.account.id,
        post,
        replier.actor,
      );
      assertEquals(suppressed, undefined);

      const stored = await tx.query.notificationTable.findMany({
        where: { accountId: recipient.account.id, type: "reply" },
      });
      assertEquals(stored.length, 0);
    });
  },
});

Deno.test({
  name:
    "createNotification still notifies for a muted actor the recipient follows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "mutefollowrecipient",
        name: "Recipient",
        email: "mutefollowrecipient@example.com",
      });
      const replier = await insertAccountWithActor(tx, {
        username: "mutefollowreplier",
        name: "Replier",
        email: "mutefollowreplier@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: recipient.account,
        content: "Original",
      });

      // Recipient follows the replier, then mutes them.
      await tx.insert(followingTable).values({
        iri: `https://example.com/follows/${crypto.randomUUID()}`,
        followerId: recipient.actor.id,
        followeeId: replier.actor.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
      await mute(tx, recipient.account, replier.actor);

      const notification = await createReplyNotification(
        tx,
        recipient.account.id,
        post,
        replier.actor,
      );
      assert(notification != null);

      const stored = await tx.query.notificationTable.findMany({
        where: { accountId: recipient.account.id, type: "reply" },
      });
      assertEquals(stored.length, 1);
    });
  },
});

Deno.test({
  name:
    "createNotification suppresses non-reply types from a muted actor even when followed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "mutesharerecipient",
        name: "Recipient",
        email: "mutesharerecipient@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "mutesharesharer",
        name: "Sharer",
        email: "mutesharesharer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: recipient.account,
        content: "Original",
      });

      // Recipient follows the sharer, then mutes them. The follow exception is
      // limited to replies/mentions, so a share must still be suppressed.
      await tx.insert(followingTable).values({
        iri: `https://example.com/follows/${crypto.randomUUID()}`,
        followerId: recipient.actor.id,
        followeeId: sharer.actor.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
      await mute(tx, recipient.account, sharer.actor);

      const notification = await createShareNotification(
        tx,
        recipient.account.id,
        post,
        sharer.actor,
      );
      assertEquals(notification, undefined);

      const stored = await tx.query.notificationTable.findMany({
        where: { accountId: recipient.account.id, type: "share" },
      });
      assertEquals(stored.length, 0);
    });
  },
});

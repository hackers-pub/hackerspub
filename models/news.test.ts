import { assert } from "@std/assert/assert";
import { assertAlmostEquals } from "@std/assert/almost-equals";
import { assertEquals } from "@std/assert/equals";
import { eq, sql } from "drizzle-orm";
import type { Transaction } from "./db.ts";
import {
  getNewsScoreStatus,
  getNewsSourceBreakdowns,
  getNewsStories,
  NEWS_EPOCH_SECONDS,
  NEWS_SOURCE_WEIGHT_BLUESKY,
  NEWS_SOURCE_WEIGHT_LOCAL,
  NEWS_SOURCE_WEIGHT_REMOTE,
  NEWS_TAU_SECONDS,
  NEWS_W_QUOTE,
  NEWS_W_REACT,
  NEWS_W_REPLY,
  NEWS_W_SHARE,
  recomputeNewsScores,
  refreshNewsScores,
  refreshNewsScoresForActor,
  refreshNewsScoresForPostLinks,
} from "./news.ts";
import { syncPostFromNoteSource } from "./post.ts";
import { actorTable, instanceTable, postTable } from "./schema.ts";
import type { Uuid } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  insertReaction,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

// Independent re-implementation of the scoring formula, used to cross-check
// the SQL in `recomputeNewsScores` against a second source of truth.
function recency(at: Date): number {
  return (at.getTime() / 1000 - NEWS_EPOCH_SECONDS) / NEWS_TAU_SECONDS;
}
function mass(
  sourceWeight: number,
  acctWeight: number,
  { quotes = 0, replies = 0, reactions = 0 } = {},
): number {
  return sourceWeight * acctWeight * (
    NEWS_W_SHARE + NEWS_W_QUOTE * quotes + NEWS_W_REPLY * replies +
    NEWS_W_REACT * reactions
  );
}
function score(weightedMass: number, latestActivity: Date): number {
  return Math.log10(Math.max(1, weightedMass)) + recency(latestActivity);
}

async function readLink(tx: Transaction, id: Uuid) {
  const link = await tx.query.postLinkTable.findFirst({ where: { id } });
  assert(link != null);
  return link;
}

Deno.test({
  name: "recomputeNewsScores ignores links with no public share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "noshare",
        name: "No Share",
        email: "noshare@example.com",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/private",
      });
      // Followers-only post: not a qualifying public share.
      await insertNotePost(tx, {
        account: sharer.account,
        visibility: "followers",
        link: { id: link.id, url: link.url },
      });

      const result = await recomputeNewsScores(tx);
      assertEquals(result.linksUpdated, 0);

      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);

      const stories = await getNewsStories(tx, {
        order: "popular",
        limit: 10,
      });
      assertEquals(stories.find((s) => s.id === link.id), undefined);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores weights local over generic remote shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "localsharer",
        name: "Local Sharer",
        email: "localsharer@example.com",
      });
      const remote = await insertRemoteActor(tx, {
        username: "remotesharer",
        name: "Remote Sharer",
        host: "mastodon.example",
      });
      const localLink = await insertPostLink(tx, {
        url: "https://example.com/local",
      });
      const remoteLink = await insertPostLink(tx, {
        url: "https://example.com/remote",
      });
      await insertNotePost(tx, {
        account: local.account,
        link: { id: localLink.id, url: localLink.url },
      });
      await insertNotePost(tx, {
        account: local.account, // satisfies the source-account type
        actorId: remote.id,
        link: { id: remoteLink.id, url: remoteLink.url },
      });

      await recomputeNewsScores(tx);

      const localRow = await readLink(tx, localLink.id);
      const remoteRow = await readLink(tx, remoteLink.id);
      assertAlmostEquals(
        localRow.weightedMass,
        mass(NEWS_SOURCE_WEIGHT_LOCAL, 1),
        1e-9,
      );
      assertAlmostEquals(
        remoteRow.weightedMass,
        mass(NEWS_SOURCE_WEIGHT_REMOTE, 1),
        1e-9,
      );
      assertAlmostEquals(
        localRow.weightedMass / remoteRow.weightedMass,
        NEWS_SOURCE_WEIGHT_LOCAL / NEWS_SOURCE_WEIGHT_REMOTE,
        1e-9,
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores down-weights Bluesky bridge shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "bskyhost",
        name: "Host",
        email: "bskyhost@example.com",
      });
      const bridged = await insertRemoteActor(tx, {
        username: "alice.bsky.social",
        name: "Alice",
        host: "bsky.brid.gy",
        handleHost: "bsky.brid.gy",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/bsky",
      });
      await insertNotePost(tx, {
        account: host.account,
        actorId: bridged.id,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);

      const row = await readLink(tx, link.id);
      assertAlmostEquals(
        row.weightedMass,
        mass(NEWS_SOURCE_WEIGHT_BLUESKY, 1),
        1e-9,
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores ranks quotes over replies over reactions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "weights",
        name: "Weights",
        email: "weights@example.com",
      });
      const quoteLink = await insertPostLink(tx, {
        url: "https://example.com/q",
      });
      const replyLink = await insertPostLink(tx, {
        url: "https://example.com/r",
      });
      const reactLink = await insertPostLink(tx, {
        url: "https://example.com/x",
      });
      const { post: quoteShare } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: quoteLink.id, url: quoteLink.url },
      });
      const { post: replyShare } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: replyLink.id, url: replyLink.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        reactionsCounts: { "❤️": 1 },
        link: { id: reactLink.id, url: reactLink.url },
      });
      // A public quote of the quote-link's share, and a public reply of the
      // reply-link's share, drive the mass (the denormalized counts would also
      // include private posts, which must not count).
      await insertNotePost(tx, {
        account: sharer.account,
        quotedPostId: quoteShare.id,
      });
      await insertNotePost(tx, {
        account: sharer.account,
        replyTargetId: replyShare.id,
      });

      await recomputeNewsScores(tx);

      const q = await readLink(tx, quoteLink.id);
      const r = await readLink(tx, replyLink.id);
      const x = await readLink(tx, reactLink.id);
      assertAlmostEquals(q.weightedMass, mass(1, 1, { quotes: 1 }), 1e-9);
      assertAlmostEquals(r.weightedMass, mass(1, 1, { replies: 1 }), 1e-9);
      assertAlmostEquals(x.weightedMass, mass(1, 1, { reactions: 1 }), 1e-9);
      assert(q.weightedMass > r.weightedMass);
      assert(r.weightedMass > x.weightedMass);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores excludes non-public replies and quotes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "privacy",
        name: "Privacy",
        email: "privacy@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/pv" });
      const { post: share } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      // One public reply + one public quote count toward the score…
      await insertNotePost(tx, {
        account: sharer.account,
        replyTargetId: share.id,
      });
      await insertNotePost(tx, {
        account: sharer.account,
        quotedPostId: share.id,
      });
      // …but followers-only and direct replies/quotes must not (they would
      // otherwise leak private discussion volume into a public score).
      await insertNotePost(tx, {
        account: sharer.account,
        visibility: "followers",
        replyTargetId: share.id,
      });
      await insertNotePost(tx, {
        account: sharer.account,
        visibility: "direct",
        quotedPostId: share.id,
      });

      await recomputeNewsScores(tx);

      const row = await readLink(tx, link.id);
      assertAlmostEquals(
        row.weightedMass,
        mass(1, 1, { quotes: 1, replies: 1 }),
        1e-9,
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores adds a recency term anchored to a fixed epoch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "recency",
        name: "Recency",
        email: "recency@example.com",
      });
      const older = await insertPostLink(tx, { url: "https://example.com/o" });
      const newer = await insertPostLink(tx, { url: "https://example.com/n" });
      const olderAt = new Date("2026-04-15T00:00:00.000Z");
      const newerAt = new Date("2026-04-16T00:00:00.000Z"); // +24h
      await insertNotePost(tx, {
        account: sharer.account,
        published: olderAt,
        link: { id: older.id, url: older.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: newerAt,
        link: { id: newer.id, url: newer.url },
      });

      await recomputeNewsScores(tx);

      const o = await readLink(tx, older.id);
      const n = await readLink(tx, newer.id);
      assertEquals(o.latestActivityAt?.getTime(), olderAt.getTime());
      assertEquals(n.latestActivityAt?.getTime(), newerAt.getTime());
      assertAlmostEquals(o.score, score(mass(1, 1), olderAt), 1e-6);
      assertAlmostEquals(n.score, score(mass(1, 1), newerAt), 1e-6);
      // 24h apart => exactly 86400 / TAU difference in the recency term.
      assertAlmostEquals(n.score - o.score, 86400 / NEWS_TAU_SECONDS, 1e-6);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores lifts an old link with a recent reaction",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "fresh",
        name: "Fresh",
        email: "fresh@example.com",
      });
      const reactor = await insertAccountWithActor(tx, {
        username: "reactor",
        name: "Reactor",
        email: "reactor@example.com",
      });
      const sharedAt = new Date("2025-01-01T00:00:00.000Z");
      const reactionAt = new Date("2026-05-29T00:00:00.000Z");

      const fresh = await insertPostLink(tx, { url: "https://example.com/f" });
      const stale = await insertPostLink(tx, { url: "https://example.com/s" });
      const { post: freshPost } = await insertNotePost(tx, {
        account: sharer.account,
        published: sharedAt,
        link: { id: fresh.id, url: fresh.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: sharedAt,
        link: { id: stale.id, url: stale.url },
      });
      // A reaction created long after the share bumps `fresh`'s activity.
      await insertReaction(tx, {
        postId: freshPost.id,
        actorId: reactor.actor.id,
        created: reactionAt,
      });

      await recomputeNewsScores(tx);

      const f = await readLink(tx, fresh.id);
      const s = await readLink(tx, stale.id);
      // The reaction timestamp wins over the (older) share publish time.
      assertEquals(f.latestActivityAt?.getTime(), reactionAt.getTime());
      assertEquals(s.latestActivityAt?.getTime(), sharedAt.getTime());
      // Same mass, but the fresh reaction lifts the old link far above the
      // otherwise-identical stale one.
      assert(f.score > s.score);

      const popular = await getNewsStories(tx, { order: "popular", limit: 10 });
      const freshIdx = popular.findIndex((l) => l.id === fresh.id);
      const staleIdx = popular.findIndex((l) => l.id === stale.id);
      assert(freshIdx >= 0 && staleIdx >= 0);
      assert(freshIdx < staleIdx);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores is idempotent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "idem",
        name: "Idem",
        email: "idem@example.com",
      });
      const a = await insertPostLink(tx, { url: "https://example.com/a" });
      const b = await insertPostLink(tx, { url: "https://example.com/b" });
      const { post: aShare } = await insertNotePost(tx, {
        account: sharer.account,
        reactionsCounts: { "❤️": 3 },
        published: new Date("2026-03-01T00:00:00.000Z"),
        link: { id: a.id, url: a.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        quotedPostId: aShare.id,
        published: new Date("2026-03-01T00:00:00.000Z"),
      });
      await insertNotePost(tx, {
        account: sharer.account,
        replyTargetId: aShare.id,
        published: new Date("2026-03-01T00:00:00.000Z"),
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2026-03-02T00:00:00.000Z"),
        link: { id: b.id, url: b.url },
      });

      await recomputeNewsScores(tx);
      const a1 = await readLink(tx, a.id);
      const b1 = await readLink(tx, b.id);
      await recomputeNewsScores(tx);
      const a2 = await readLink(tx, a.id);
      const b2 = await readLink(tx, b.id);

      for (const [first, second] of [[a1, a2], [b1, b2]] as const) {
        assertEquals(first.score, second.score);
        assertEquals(first.weightedMass, second.weightedMass);
        assertEquals(first.recencyComponent, second.recencyComponent);
        assertEquals(first.postCount, second.postCount);
        assertEquals(
          first.firstSharedAt?.getTime(),
          second.firstSharedAt?.getTime(),
        );
        assertEquals(
          first.latestActivityAt?.getTime(),
          second.latestActivityAt?.getTime(),
        );
      }
    });
  },
});

Deno.test({
  name: "recomputeNewsScores can target a subset of links",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "subset",
        name: "Subset",
        email: "subset@example.com",
      });
      const a = await insertPostLink(tx, { url: "https://example.com/sa" });
      const b = await insertPostLink(tx, { url: "https://example.com/sb" });
      await insertNotePost(tx, {
        account: sharer.account,
        link: { id: a.id, url: a.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        link: { id: b.id, url: b.url },
      });

      const result = await recomputeNewsScores(tx, { linkIds: [a.id] });
      assertEquals(result.linksUpdated, 1);
      assert((await readLink(tx, a.id)).latestActivityAt != null);
      assertEquals((await readLink(tx, b.id)).latestActivityAt, null);

      await recomputeNewsScores(tx);
      assert((await readLink(tx, b.id)).latestActivityAt != null);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores activeSince picks up fresh activity on old links",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "sweep",
        name: "Sweep",
        email: "sweep@example.com",
      });
      const reactor = await insertAccountWithActor(tx, {
        username: "sweepreactor",
        name: "Sweep Reactor",
        email: "sweepreactor@example.com",
      });
      const sharedAt = new Date("2025-06-01T00:00:00.000Z");
      const active = await insertPostLink(tx, {
        url: "https://example.com/sw1",
      });
      const idle = await insertPostLink(tx, { url: "https://example.com/sw2" });
      const { post: activePost } = await insertNotePost(tx, {
        account: sharer.account,
        published: sharedAt,
        link: { id: active.id, url: active.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: sharedAt,
        link: { id: idle.id, url: idle.url },
      });

      await recomputeNewsScores(tx);
      assertEquals(
        (await readLink(tx, active.id)).latestActivityAt?.getTime(),
        sharedAt.getTime(),
      );

      // A reaction arrives long after the initial scoring.
      const reactionAt = new Date("2026-05-29T00:00:00.000Z");
      await insertReaction(tx, {
        postId: activePost.id,
        actorId: reactor.actor.id,
        created: reactionAt,
      });

      // The sweep targets only links with activity since the cutoff, derived
      // from source timestamps (not the stale stored latestActivityAt).
      const result = await recomputeNewsScores(tx, {
        activeSince: new Date("2026-01-01T00:00:00.000Z"),
      });
      assertEquals(result.linksUpdated, 1);
      assertEquals(
        (await readLink(tx, active.id)).latestActivityAt?.getTime(),
        reactionAt.getTime(),
      );
      // The idle link had no fresh activity, so the sweep left it untouched.
      assertEquals(
        (await readLink(tx, idle.id)).latestActivityAt?.getTime(),
        sharedAt.getTime(),
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores drops a link that lost its last public share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "dropout",
        name: "Dropout",
        email: "dropout@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/d" });
      const { post } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      // The only public share becomes followers-only.
      await tx.update(postTable).set({ visibility: "followers" }).where(
        eq(postTable.id, post.id),
      );
      await recomputeNewsScores(tx);

      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores activeSince picks up a federated count update",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "sweepupdate",
        name: "Sweep Update",
        email: "sweepupdate@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/swu" });
      const { post } = await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2025-06-01T00:00:00.000Z"),
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);
      const before = await readLink(tx, link.id);

      // A federated Update bumps `updated` and revises the reaction totals
      // without creating any local reply/quote/reaction row.
      await tx.execute(
        sql`update post
            set updated = '2026-05-29T00:00:00Z',
                reactions_counts = '{"❤️": 5}'::jsonb
            where id = ${post.id}`,
      );
      const result = await recomputeNewsScores(tx, {
        activeSince: new Date("2026-01-01T00:00:00.000Z"),
      });

      assertEquals(result.linksUpdated, 1);
      const after = await readLink(tx, link.id);
      assert(after.weightedMass > before.weightedMass);
    });
  },
});

Deno.test({
  name:
    "recomputeNewsScores activeSince still drops a link that lost its share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "sweepdrop",
        name: "Sweep Drop",
        email: "sweepdrop@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/sd" });
      const { post } = await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2026-05-20T00:00:00.000Z"),
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      // The only public share becomes followers-only, then a sweep runs.  The
      // sweep's zeroing scopes by the stored latestActivityAt, so it still
      // resets the dropped-out link even though it is no longer "active".
      await tx.update(postTable).set({ visibility: "followers" }).where(
        eq(postTable.id, post.id),
      );
      await recomputeNewsScores(tx, {
        activeSince: new Date("2026-05-01T00:00:00.000Z"),
      });

      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
    });
  },
});

Deno.test({
  name: "getNewsStories diverges between popular and allTime order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "diverge",
        name: "Diverge",
        email: "diverge@example.com",
      });
      const heavyOld = await insertPostLink(tx, {
        url: "https://example.com/heavy",
      });
      const lightNew = await insertPostLink(tx, {
        url: "https://example.com/light",
      });
      // Heavy engagement but shared a year ago.
      await insertNotePost(tx, {
        account: sharer.account,
        reactionsCounts: { "❤️": 150 },
        published: new Date("2025-05-30T00:00:00.000Z"),
        link: { id: heavyOld.id, url: heavyOld.url },
      });
      // Light engagement but shared recently.
      await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2026-05-30T00:00:00.000Z"),
        link: { id: lightNew.id, url: lightNew.url },
      });

      await recomputeNewsScores(tx);

      const byAllTime = await getNewsStories(tx, {
        order: "allTime",
        limit: 10,
      });
      const byPopular = await getNewsStories(tx, {
        order: "popular",
        limit: 10,
      });
      assertEquals(byAllTime[0].id, heavyOld.id);
      assertEquals(byPopular[0].id, lightNew.id);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores aggregates postCount and firstSharedAt",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "aggr",
        name: "Aggr",
        email: "aggr@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/agg" });
      const times = [
        new Date("2026-05-10T00:00:00.000Z"),
        new Date("2026-05-12T00:00:00.000Z"),
        new Date("2026-05-11T00:00:00.000Z"),
      ];
      for (const published of times) {
        await insertNotePost(tx, {
          account: sharer.account,
          published,
          link: { id: link.id, url: link.url },
        });
      }

      await recomputeNewsScores(tx);

      const row = await readLink(tx, link.id);
      assertEquals(row.postCount, 3);
      assertEquals(
        row.firstSharedAt?.getTime(),
        new Date("2026-05-10T00:00:00.000Z").getTime(),
      );
      assertEquals(
        row.latestActivityAt?.getTime(),
        new Date("2026-05-12T00:00:00.000Z").getTime(),
      );
    });
  },
});

Deno.test({
  name: "getNewsStories paginates by keyset without gaps or overlaps",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "pager",
        name: "Pager",
        email: "pager@example.com",
      });
      const ids: Uuid[] = [];
      for (let i = 0; i < 5; i++) {
        const link = await insertPostLink(tx, {
          url: `https://example.com/page-${i}`,
        });
        await insertNotePost(tx, {
          account: sharer.account,
          // Distinct published times => distinct firstSharedAt order.
          published: new Date(Date.UTC(2026, 4, 10 + i)),
          link: { id: link.id, url: link.url },
        });
        ids.push(link.id);
      }

      await recomputeNewsScores(tx);

      const page1 = await getNewsStories(tx, { order: "newest", limit: 2 });
      assertEquals(page1.length, 2);
      const last = page1[page1.length - 1];
      const page2 = await getNewsStories(tx, {
        order: "newest",
        limit: 2,
        after: { value: last.firstSharedAt!, id: last.id },
      });
      assertEquals(page2.length, 2);

      const seen = [...page1, ...page2].map((l) => l.id);
      assertEquals(new Set(seen).size, seen.length); // no overlaps
      // newest-first: published descending.
      assertEquals(seen[0], ids[4]);
      assertEquals(seen[1], ids[3]);
      assertEquals(seen[2], ids[2]);
      assertEquals(seen[3], ids[1]);
    });
  },
});

Deno.test({
  name: "getNewsStories newest pagination keeps sub-millisecond-close links",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "micropage",
        name: "Micro Page",
        email: "micropage@example.com",
      });
      const a = await insertPostLink(tx, { url: "https://example.com/ua" });
      const b = await insertPostLink(tx, { url: "https://example.com/ub" });
      const { post: postA } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: a.id, url: a.url },
      });
      const { post: postB } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: b.id, url: b.url },
      });
      // Same millisecond, different microseconds: the precision a JS-Date
      // cursor cannot represent.
      await tx.execute(
        sql`update post set published = '2026-05-20T00:00:00.000800Z'
            where id = ${postA.id}`,
      );
      await tx.execute(
        sql`update post set published = '2026-05-20T00:00:00.000300Z'
            where id = ${postB.id}`,
      );
      await recomputeNewsScores(tx);

      // Walk the feed one story at a time using the encoded cursor.
      const seen: Uuid[] = [];
      let after: { value: number | Date; id: Uuid } | undefined;
      for (let i = 0; i < 3; i++) {
        const page = await getNewsStories(tx, {
          order: "newest",
          limit: 1,
          after,
        });
        if (page.length < 1) break;
        const link = page[0];
        seen.push(link.id);
        after = { value: link.firstSharedAt!, id: link.id };
      }
      assertEquals(new Set(seen).size, 2);
      assert(seen.includes(a.id));
      assert(seen.includes(b.id));
    });
  },
});

Deno.test({
  name: "getNewsScoreStatus reports scored link count and last recompute",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "status",
        name: "Status",
        email: "status@example.com",
      });
      const before = await getNewsScoreStatus(tx);
      assertEquals(before.scoredLinkCount, 0);

      const link = await insertPostLink(tx, { url: "https://example.com/st" });
      await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);

      const after = await getNewsScoreStatus(tx);
      assertEquals(after.scoredLinkCount, 1);
      assert(after.lastRecomputedAt != null);
    });
  },
});

Deno.test({
  name: "refreshNewsScores scores a newly shared link without a batch run",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "hookshare",
        name: "Hook Share",
        email: "hookshare@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/hk" });
      await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });

      assertEquals((await readLink(tx, link.id)).latestActivityAt, null);
      await refreshNewsScores(tx, [link.id]);
      const row = await readLink(tx, link.id);
      assert(row.latestActivityAt != null);
      assert(row.score > 0);
    });
  },
});

Deno.test({
  name: "refreshNewsScores drops a link whose share is no longer public",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "hookdrop",
        name: "Hook Drop",
        email: "hookdrop@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/hd" });
      const { post } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      await refreshNewsScores(tx, [link.id]);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      // The edit removes the only public share; refreshing the (previous) link
      // drops it from the feed.
      await tx.update(postTable).set({ visibility: "followers" }).where(
        eq(postTable.id, post.id),
      );
      await refreshNewsScores(tx, [link.id]);
      assertEquals((await readLink(tx, link.id)).latestActivityAt, null);
      assertEquals((await readLink(tx, link.id)).score, 0);
    });
  },
});

Deno.test({
  name: "syncPostFromNoteSource clears a removed link and drops the story",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "editor",
        name: "Editor",
        email: "editor@example.com",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/edited",
      });
      // The note carries a link on the row but its content has none, so a
      // re-sync renders no link and must clear `link_id`.
      const { noteSourceId } = await insertNotePost(tx, {
        account: author.account,
        content: "Hello world",
        link: { id: link.id, url: link.url },
      });
      await refreshNewsScores(tx, [link.id]);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      const noteSource = await tx.query.noteSourceTable.findFirst({
        where: { id: noteSourceId },
        with: {
          account: {
            with: { avatarMedium: true, emails: true, links: true },
          },
          media: { with: { medium: true } },
        },
      });
      assert(noteSource != null);

      const updated = await syncPostFromNoteSource(fedCtx, noteSource);
      assert(updated != null);
      // The link is cleared (not left as the stale previous value)...
      assertEquals(updated.linkId, null);
      // ...and the incremental refresh of the previous link drops the story.
      assertEquals((await readLink(tx, link.id)).latestActivityAt, null);
      assertEquals((await readLink(tx, link.id)).score, 0);
    });
  },
});

Deno.test({
  name: "getNewsSourceBreakdowns counts NULL-software instances as remote",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "brklocal",
        name: "Brk Local",
        email: "brklocal@example.com",
      });
      // A remote instance whose `software` is unknown (NULL).
      await tx.insert(instanceTable).values({
        host: "unknown.example",
        software: null,
        softwareVersion: null,
      });
      const unknownRemote = await insertRemoteActor(tx, {
        username: "brkunknown",
        name: "Brk Unknown",
        host: "unknown.example",
      });
      const bridged = await insertRemoteActor(tx, {
        username: "brkbsky.bsky.social",
        name: "Brk Bsky",
        host: "bsky.brid.gy",
        handleHost: "bsky.brid.gy",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/brk" });
      await insertNotePost(tx, {
        account: local.account,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: local.account,
        actorId: unknownRemote.id,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: local.account,
        actorId: bridged.id,
        link: { id: link.id, url: link.url },
      });

      const breakdowns = await getNewsSourceBreakdowns(tx, [link.id]);
      // The NULL-software actor must land in `remote`, not vanish.
      assertEquals(breakdowns.get(link.id), {
        local: 1,
        remote: 1,
        bluesky: 1,
      });
    });
  },
});

Deno.test({
  name: "refreshNewsScoresForPostLinks reflects a deleted public reply",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "deletereply",
        name: "Delete Reply",
        email: "deletereply@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/dr" });
      const { post: share } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      const { post: reply } = await insertNotePost(tx, {
        account: sharer.account,
        replyTargetId: share.id,
      });
      await recomputeNewsScores(tx);
      assertAlmostEquals(
        (await readLink(tx, link.id)).weightedMass,
        mass(1, 1, { replies: 1 }),
        1e-9,
      );

      // Delete the reply, then refresh through the destructive-path helper:
      // the parent link's mass drops back to just the share.
      await tx.delete(postTable).where(eq(postTable.id, reply.id));
      await refreshNewsScoresForPostLinks(tx, reply);
      assertAlmostEquals(
        (await readLink(tx, link.id)).weightedMass,
        mass(1, 1),
        1e-9,
      );
    });
  },
});

Deno.test({
  name: "refreshNewsScoresForPostLinks drops a link when its share is deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "deleteshare",
        name: "Delete Share",
        email: "deleteshare@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/ds" });
      const { post: share } = await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      await tx.delete(postTable).where(eq(postTable.id, share.id));
      await refreshNewsScoresForPostLinks(tx, share);
      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
    });
  },
});

Deno.test({
  name: "refreshNewsScores ignores null/empty link ids",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      await refreshNewsScores(tx, []);
      await refreshNewsScores(tx, [null, undefined]);
      const status = await getNewsScoreStatus(tx);
      assertEquals(status.scoredLinkCount, 0);
    });
  },
});

// ---------------------------------------------------------------------------
// Bot exclusion: shares authored by Service/Application actors (automated link
// feeds) must not surface a link as news.  Replies/quotes/reactions are not
// filtered by author; only the *sharing* post's actor type matters.
// ---------------------------------------------------------------------------

Deno.test({
  name: "recomputeNewsScores excludes a Service-actor (bot) share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "bothost1",
        name: "Bot Host",
        email: "bothost1@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "feedbot",
        name: "Feed Bot",
        host: "bots.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/svc" });
      await insertNotePost(tx, {
        account: host.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });

      const result = await recomputeNewsScores(tx);
      assertEquals(result.linksUpdated, 0);
      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
      const stories = await getNewsStories(tx, { order: "popular", limit: 10 });
      assertEquals(stories.find((s) => s.id === link.id), undefined);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores excludes an Application-actor (bot) share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "bothost2",
        name: "Bot Host 2",
        email: "bothost2@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "appbot",
        name: "App Bot",
        host: "bots.example",
        type: "Application",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/app" });
      await insertNotePost(tx, {
        account: host.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      const row = await readLink(tx, link.id);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores ignores a bot share when a human also shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const human = await insertAccountWithActor(tx, {
        username: "humanmix",
        name: "Human Mix",
        email: "humanmix@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "mixbot",
        name: "Mix Bot",
        host: "bots.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/mix" });
      const baseline = await insertPostLink(tx, {
        url: "https://example.com/base",
      });
      // The link gets one human share and one bot share; the baseline gets only
      // the same human share.  The bot share must contribute nothing, so the two
      // links end up with identical mass and score.
      await insertNotePost(tx, {
        account: human.account,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: human.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: human.account,
        link: { id: baseline.id, url: baseline.url },
      });

      await recomputeNewsScores(tx);

      const linkRow = await readLink(tx, link.id);
      const baselineRow = await readLink(tx, baseline.id);
      assertEquals(linkRow.postCount, 1);
      assertAlmostEquals(linkRow.weightedMass, baselineRow.weightedMass, 1e-9);
      assertAlmostEquals(linkRow.score, baselineRow.score, 1e-9);
      assertEquals(
        linkRow.latestActivityAt?.getTime(),
        baselineRow.latestActivityAt?.getTime(),
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores still scores a Group-actor share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "grouphost",
        name: "Group Host",
        email: "grouphost@example.com",
      });
      // Group/Organization accounts are not bots: their shares still count.
      const group = await insertRemoteActor(tx, {
        username: "guppe",
        name: "Guppe Group",
        host: "a.gup.pe",
        type: "Group",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/group",
      });
      await insertNotePost(tx, {
        account: host.account,
        actorId: group.id,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      const row = await readLink(tx, link.id);
      assert(row.latestActivityAt != null);
      assertEquals(row.postCount, 1);
    });
  },
});

Deno.test({
  name: "refreshNewsScores drops a link left with only a bot share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const human = await insertAccountWithActor(tx, {
        username: "dropbot",
        name: "Drop Bot",
        email: "dropbot@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "lingerbot",
        name: "Linger Bot",
        host: "bots.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/drop",
      });
      const { post: humanShare } = await insertNotePost(tx, {
        account: human.account,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: human.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      assert((await readLink(tx, link.id)).latestActivityAt != null);
      assertEquals((await readLink(tx, link.id)).postCount, 1);

      // Delete the only human share: the bot share remains but does not qualify,
      // so the incremental refresh drops the link from the feed.
      await tx.delete(postTable).where(eq(postTable.id, humanShare.id));
      await refreshNewsScores(tx, [link.id]);

      const row = await readLink(tx, link.id);
      assertEquals(row.score, 0);
      assertEquals(row.latestActivityAt, null);
      assertEquals(row.postCount, 0);
    });
  },
});

Deno.test({
  name: "recomputeNewsScores activeSince skips a bot-only link",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "sweepbot",
        name: "Sweep Bot Host",
        email: "sweepbot@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "sweepfeedbot",
        name: "Sweep Feed Bot",
        host: "bots.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/swb" });
      await insertNotePost(tx, {
        account: host.account,
        actorId: bot.id,
        published: new Date("2026-05-20T00:00:00.000Z"),
        link: { id: link.id, url: link.url },
      });

      const result = await recomputeNewsScores(tx, {
        activeSince: new Date("2026-01-01T00:00:00.000Z"),
      });
      assertEquals(result.linksUpdated, 0);
      assertEquals((await readLink(tx, link.id)).latestActivityAt, null);
    });
  },
});

Deno.test({
  name: "getNewsSourceBreakdowns excludes bot shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "brkbotlocal",
        name: "Brk Bot Local",
        email: "brkbotlocal@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "brkbot",
        name: "Brk Bot",
        host: "mastodon.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/brkbot",
      });
      await insertNotePost(tx, {
        account: local.account,
        link: { id: link.id, url: link.url },
      });
      // A remote Service share would otherwise be counted as `remote`.
      await insertNotePost(tx, {
        account: local.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });

      const breakdowns = await getNewsSourceBreakdowns(tx, [link.id]);
      assertEquals(breakdowns.get(link.id), {
        local: 1,
        remote: 0,
        bluesky: 0,
      });
    });
  },
});

Deno.test({
  name: "refreshNewsScoresForActor re-scores links across a bot transition",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "transhost",
        name: "Trans Host",
        email: "transhost@example.com",
      });
      // The actor starts as a Person, so its share counts.
      const actor = await insertRemoteActor(tx, {
        username: "flipper",
        name: "Flipper",
        host: "mastodon.example",
        type: "Person",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/flip",
      });
      await insertNotePost(tx, {
        account: host.account,
        actorId: actor.id,
        link: { id: link.id, url: link.url },
      });

      await recomputeNewsScores(tx);
      assert((await readLink(tx, link.id)).latestActivityAt != null);

      // The actor toggles Mastodon's bot flag, federating as a Service: its
      // share no longer qualifies, and refreshing by actor drops the link.
      await tx.update(actorTable).set({ type: "Service" }).where(
        eq(actorTable.id, actor.id),
      );
      await refreshNewsScoresForActor(tx, actor.id);
      const botted = await readLink(tx, link.id);
      assertEquals(botted.score, 0);
      assertEquals(botted.latestActivityAt, null);
      assertEquals(botted.postCount, 0);

      // Turning the bot flag back off re-scores the link.
      await tx.update(actorTable).set({ type: "Person" }).where(
        eq(actorTable.id, actor.id),
      );
      await refreshNewsScoresForActor(tx, actor.id);
      assert((await readLink(tx, link.id)).latestActivityAt != null);
    });
  },
});

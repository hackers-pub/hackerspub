import assert from "node:assert";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import {
  addNewsExcludedPattern,
  addNewsPreferredSharer,
  drainNewsRescoreQueue,
  enqueueNewsRescore,
  getNewsDiscussionCounts,
  getNewsExcludedPatterns,
  getNewsPenalizedStories,
  getNewsPreferredSharers,
  getNewsScoreStatus,
  getNewsSourceBreakdowns,
  getNewsStories,
  InvalidNewsPatternError,
  NEWS_EPOCH_SECONDS,
  NEWS_PENALTY_BURY,
  NEWS_PENALTY_DEMOTE,
  NEWS_PROMOTE_NORMAL,
  NEWS_PROMOTE_STRONG,
  NEWS_REPEAT_CAP,
  NEWS_REPEAT_FRESH_MIN_SECONDS,
  NEWS_REPEAT_RECOVERY_TAU_SECONDS,
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
  removeNewsExcludedPattern,
  removeNewsPreferredSharer,
  setNewsScorePenalty,
} from "./news.ts";
import { syncPostFromNoteSource } from "./post.ts";
import {
  actorTable,
  instanceTable,
  newsRescoreQueueTable,
  postTable,
} from "./schema.ts";
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

function assertAlmostEquals(
  actual: number,
  expected: number,
  delta: number,
): void {
  assert.ok(
    Math.abs(actual - expected) <= delta,
    `Expected ${actual} to be within ${delta} of ${expected}`,
  );
}

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

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlText).join("");
  if (value != null && typeof value === "object") {
    if ("queryChunks" in value) {
      return sqlText((value as { queryChunks: unknown[] }).queryChunks);
    }
    if ("value" in value) return sqlText((value as { value: unknown }).value);
  }
  return "";
}

// Base-share multiplier for a repeat share, mirroring the SQL: a first share is
// 1, a repeat recovers toward NEWS_REPEAT_CAP as the gap grows.
function repeatFactor(gapSeconds: number): number {
  return NEWS_REPEAT_CAP *
    (1 - Math.exp(-gapSeconds / NEWS_REPEAT_RECOVERY_TAU_SECONDS));
}

async function readLink(tx: Transaction, id: Uuid) {
  const link = await tx.query.postLinkTable.findFirst({ where: { id } });
  assert.ok(link != null);
  return link;
}

test("recomputeNewsScores activeSince reuses one materialized active-link set", async () => {
  const activeLinkId = "019ec23e-01bf-7e35-a831-bd1b6dd6789e" as Uuid;
  const calls: string[] = [];
  const isActiveLinkSweep = (text: string): boolean =>
    text.includes("s.updated >=") && text.includes("r.created >=");
  const fakeDb = {
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> =>
      await fn(fakeDb as unknown as Database),
    select: () => ({
      from: () => ({
        where: async () => [],
        then: (resolve: (value: unknown[]) => unknown) => resolve([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
    execute: async (query: unknown): Promise<unknown[]> => {
      const text = sqlText(query);
      calls.push(text);
      if (
        isActiveLinkSweep(text) &&
        !text.includes("with share_roots as")
      ) {
        return [{ link_id: activeLinkId }];
      }
      if (text.includes("with share_roots as")) return [{ id: activeLinkId }];
      return [];
    },
  } as unknown as Database;

  const result = await recomputeNewsScores(fakeDb, {
    activeSince: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.deepEqual(result.linksUpdated, 1);
  const aggregate = calls.find((text) => text.includes("with share_roots as"));
  assert.ok(aggregate != null);
  assert.deepEqual(
    isActiveLinkSweep(aggregate),
    false,
    "aggregate SQL should consume materialized link ids instead of embedding the active-link sweep",
  );
  assert.deepEqual(
    calls.filter((text) =>
      isActiveLinkSweep(text) && !text.includes("with share_roots as")
    ).length,
    1,
  );
});

test("recomputeNewsScores ignores links with no public share", async () => {
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
    assert.deepEqual(result.linksUpdated, 0);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);

    const stories = await getNewsStories(tx, {
      order: "popular",
      limit: 10,
    });
    assert.deepEqual(stories.find((s) => s.id === link.id), undefined);
  });
});

test("recomputeNewsScores weights local over generic remote shares", async () => {
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
});

test("recomputeNewsScores down-weights Bluesky bridge shares", async () => {
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
});

test("recomputeNewsScores ranks quotes over replies over reactions", async () => {
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
    assert.ok(q.weightedMass > r.weightedMass);
    assert.ok(r.weightedMass > x.weightedMass);
  });
});

test("recomputeNewsScores excludes non-public replies and quotes", async () => {
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
});

test("recomputeNewsScores excludes censored and sanction-hidden content", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "modsharer",
      name: "Sharer",
      email: "modsharer@example.com",
    });
    const banned = await insertAccountWithActor(tx, {
      username: "modbanned",
      name: "Banned",
      email: "modbanned@example.com",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/mod" });
    const sharedAt = new Date("2026-04-15T00:00:00.000Z");
    const { post: share } = await insertNotePost(tx, {
      account: sharer.account,
      link: { id: link.id, url: link.url },
      published: sharedAt,
    });
    // A censored reply must not add mass nor refresh the link's freshness…
    const { post: censoredReply } = await insertNotePost(tx, {
      account: sharer.account,
      replyTargetId: share.id,
      published: new Date("2026-04-16T00:00:00.000Z"),
    });
    await tx.update(postTable)
      .set({ censored: sql`CURRENT_TIMESTAMP` })
      .where(eq(postTable.id, censoredReply.id));
    // …nor must a quote by a banned author…
    await insertNotePost(tx, {
      account: banned.account,
      quotedPostId: share.id,
      published: new Date("2026-04-16T00:00:00.000Z"),
    });
    await tx.update(actorTable)
      .set({ suspended: new Date("2026-04-15T01:00:00.000Z") })
      .where(eq(actorTable.id, banned.actor.id));
    // …nor a censored second share of the same link.
    const { post: censoredShare } = await insertNotePost(tx, {
      account: banned.account,
      link: { id: link.id, url: link.url },
      published: new Date("2026-04-16T00:00:00.000Z"),
    });
    await tx.update(postTable)
      .set({ censored: sql`CURRENT_TIMESTAMP` })
      .where(eq(postTable.id, censoredShare.id));

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assertAlmostEquals(row.weightedMass, mass(1, 1), 1e-9);
    assert.deepEqual(row.latestActivityAt, sharedAt);
    assert.equal(row.postCount, 1);
  });
});

test("recomputeNewsScores adds a recency term anchored to a fixed epoch", async () => {
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
    assert.deepEqual(o.latestActivityAt?.getTime(), olderAt.getTime());
    assert.deepEqual(n.latestActivityAt?.getTime(), newerAt.getTime());
    assertAlmostEquals(o.score, score(mass(1, 1), olderAt), 1e-6);
    assertAlmostEquals(n.score, score(mass(1, 1), newerAt), 1e-6);
    // 24h apart => exactly 86400 / TAU difference in the recency term.
    assertAlmostEquals(n.score - o.score, 86400 / NEWS_TAU_SECONDS, 1e-6);
  });
});

test("recomputeNewsScores lifts an old link with a recent reaction", async () => {
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
    assert.deepEqual(f.latestActivityAt?.getTime(), reactionAt.getTime());
    assert.deepEqual(s.latestActivityAt?.getTime(), sharedAt.getTime());
    // Same mass, but the fresh reaction lifts the old link far above the
    // otherwise-identical stale one.
    assert.ok(f.score > s.score);

    const popular = await getNewsStories(tx, { order: "popular", limit: 10 });
    const freshIdx = popular.findIndex((l) => l.id === fresh.id);
    const staleIdx = popular.findIndex((l) => l.id === stale.id);
    assert.ok(freshIdx >= 0 && staleIdx >= 0);
    assert.ok(freshIdx < staleIdx);
  });
});

test("recomputeNewsScores is idempotent", async () => {
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
      assert.deepEqual(first.score, second.score);
      assert.deepEqual(first.weightedMass, second.weightedMass);
      assert.deepEqual(first.recencyComponent, second.recencyComponent);
      assert.deepEqual(first.postCount, second.postCount);
      assert.deepEqual(
        first.firstSharedAt?.getTime(),
        second.firstSharedAt?.getTime(),
      );
      assert.deepEqual(
        first.latestActivityAt?.getTime(),
        second.latestActivityAt?.getTime(),
      );
    }
  });
});

test("recomputeNewsScores can target a subset of links", async () => {
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
    assert.deepEqual(result.linksUpdated, 1);
    assert.ok((await readLink(tx, a.id)).latestActivityAt != null);
    assert.deepEqual((await readLink(tx, b.id)).latestActivityAt, null);

    await recomputeNewsScores(tx);
    assert.ok((await readLink(tx, b.id)).latestActivityAt != null);
  });
});

test("recomputeNewsScores activeSince picks up fresh activity on old links", async () => {
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
    assert.deepEqual(
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
    assert.deepEqual(result.linksUpdated, 1);
    assert.deepEqual(
      (await readLink(tx, active.id)).latestActivityAt?.getTime(),
      reactionAt.getTime(),
    );
    // The idle link had no fresh activity, so the sweep left it untouched.
    assert.deepEqual(
      (await readLink(tx, idle.id)).latestActivityAt?.getTime(),
      sharedAt.getTime(),
    );
  });
});

test("recomputeNewsScores drops a link that lost its last public share", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

    // The only public share becomes followers-only.
    await tx.update(postTable).set({ visibility: "followers" }).where(
      eq(postTable.id, post.id),
    );
    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
  });
});

test("recomputeNewsScores activeSince picks up a federated count update", async () => {
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

    assert.deepEqual(result.linksUpdated, 1);
    const after = await readLink(tx, link.id);
    assert.ok(after.weightedMass > before.weightedMass);
  });
});

test("recomputeNewsScores activeSince still drops a link that lost its share", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

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
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
  });
});

test("getNewsStories diverges between popular and allTime order", async () => {
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
    assert.deepEqual(byAllTime[0].id, heavyOld.id);
    assert.deepEqual(byPopular[0].id, lightNew.id);
  });
});

test("recomputeNewsScores aggregates postCount and firstSharedAt", async () => {
  await withRollback(async (tx) => {
    const link = await insertPostLink(tx, { url: "https://example.com/agg" });
    const times = [
      new Date("2026-05-10T00:00:00.000Z"),
      new Date("2026-05-12T00:00:00.000Z"),
      new Date("2026-05-11T00:00:00.000Z"),
    ];
    // Distinct accounts so each is a full-weight first share (this exercises
    // aggregation, not the same-account repeat damping).
    for (let i = 0; i < times.length; i++) {
      const sharer = await insertAccountWithActor(tx, {
        username: `aggr${i}`,
        name: `Aggr ${i}`,
        email: `aggr${i}@example.com`,
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: times[i],
        link: { id: link.id, url: link.url },
      });
    }

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 3);
    assert.deepEqual(
      row.firstSharedAt?.getTime(),
      new Date("2026-05-10T00:00:00.000Z").getTime(),
    );
    assert.deepEqual(
      row.latestActivityAt?.getTime(),
      new Date("2026-05-12T00:00:00.000Z").getTime(),
    );
  });
});

test("recomputeNewsScores counts boosts of Article news posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articleauthor",
      name: "Article Author",
      email: "article-author@example.com",
    });
    const booster = await insertAccountWithActor(tx, {
      username: "articlebooster",
      name: "Article Booster",
      email: "article-booster@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "http://localhost/@article-author/article",
    });
    const { post: article } = await insertNotePost(tx, {
      account: author.account,
      published: new Date("2026-05-10T00:00:00.000Z"),
      link: { id: link.id, url: link.url },
    });
    await tx.update(postTable).set({
      type: "Article",
      noteSourceId: null,
      name: "Article",
      url: link.url,
    }).where(eq(postTable.id, article.id));
    await insertNotePost(tx, {
      account: booster.account,
      sharedPostId: article.id,
      published: new Date("2026-05-11T00:00:00.000Z"),
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 2);
    assertAlmostEquals(row.weightedMass, 2 * NEWS_W_SHARE, 0.000001);
    assert.deepEqual(
      row.latestActivityAt?.getTime(),
      new Date("2026-05-11T00:00:00.000Z").getTime(),
    );

    const breakdowns = await getNewsSourceBreakdowns(tx, [link.id]);
    assert.deepEqual(breakdowns.get(link.id), {
      local: 2,
      remote: 0,
      bluesky: 0,
    });
  });
});

test("recomputeNewsScores ignores boosts of ordinary link-sharing notes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "noteauthor",
      name: "Note Author",
      email: "note-author@example.com",
    });
    const booster = await insertAccountWithActor(tx, {
      username: "notebooster",
      name: "Note Booster",
      email: "note-booster@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/ordinary-note",
    });
    const { post: note } = await insertNotePost(tx, {
      account: author.account,
      published: new Date("2026-05-10T00:00:00.000Z"),
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: booster.account,
      sharedPostId: note.id,
      published: new Date("2026-05-11T00:00:00.000Z"),
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 1);
    assertAlmostEquals(row.weightedMass, NEWS_W_SHARE, 0.000001);
    assert.deepEqual(
      row.latestActivityAt?.getTime(),
      new Date("2026-05-10T00:00:00.000Z").getTime(),
    );

    const breakdowns = await getNewsSourceBreakdowns(tx, [link.id]);
    assert.deepEqual(breakdowns.get(link.id), {
      local: 1,
      remote: 0,
      bluesky: 0,
    });
  });
});

test("getNewsStories paginates by keyset without gaps or overlaps", async () => {
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
    assert.deepEqual(page1.length, 2);
    const last = page1[page1.length - 1];
    const page2 = await getNewsStories(tx, {
      order: "newest",
      limit: 2,
      after: { value: last.firstSharedAt!, id: last.id },
    });
    assert.deepEqual(page2.length, 2);

    const seen = [...page1, ...page2].map((l) => l.id);
    assert.deepEqual(new Set(seen).size, seen.length); // no overlaps
    // newest-first: published descending.
    assert.deepEqual(seen[0], ids[4]);
    assert.deepEqual(seen[1], ids[3]);
    assert.deepEqual(seen[2], ids[2]);
    assert.deepEqual(seen[3], ids[1]);
  });
});

test("getNewsStories newest pagination keeps sub-millisecond-close links", async () => {
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
    assert.deepEqual(new Set(seen).size, 2);
    assert.ok(seen.includes(a.id));
    assert.ok(seen.includes(b.id));
  });
});

test("getNewsScoreStatus reports scored link count and last recompute", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "status",
      name: "Status",
      email: "status@example.com",
    });
    const before = await getNewsScoreStatus(tx);
    assert.deepEqual(before.scoredLinkCount, 0);

    const link = await insertPostLink(tx, { url: "https://example.com/st" });
    await insertNotePost(tx, {
      account: sharer.account,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);

    const after = await getNewsScoreStatus(tx);
    assert.deepEqual(after.scoredLinkCount, 1);
    assert.ok(after.lastRecomputedAt != null);
  });
});

test("refreshNewsScores scores a newly shared link without a batch run", async () => {
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

    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
    await refreshNewsScores(tx, [link.id]);
    const row = await readLink(tx, link.id);
    assert.ok(row.latestActivityAt != null);
    assert.ok(row.score > 0);
  });
});

test("refreshNewsScores drops a link whose share is no longer public", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

    // The edit removes the only public share; refreshing the (previous) link
    // drops it from the feed.
    await tx.update(postTable).set({ visibility: "followers" }).where(
      eq(postTable.id, post.id),
    );
    await refreshNewsScores(tx, [link.id]);
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
    assert.deepEqual((await readLink(tx, link.id)).score, 0);
  });
});

test("syncPostFromNoteSource clears a removed link and drops the story", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: {
          with: { avatarMedium: true, emails: true, links: true },
        },
        media: { with: { medium: true } },
      },
    });
    assert.ok(noteSource != null);

    const updated = await syncPostFromNoteSource(fedCtx, noteSource);
    assert.ok(updated != null);
    // The link is cleared (not left as the stale previous value)...
    assert.deepEqual(updated.linkId, null);
    // ...and the incremental refresh of the previous link drops the story.
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
    assert.deepEqual((await readLink(tx, link.id)).score, 0);
  });
});

test("getNewsSourceBreakdowns counts NULL-software instances as remote", async () => {
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
    assert.deepEqual(breakdowns.get(link.id), {
      local: 1,
      remote: 1,
      bluesky: 1,
    });
  });
});

test("refreshNewsScoresForPostLinks reflects a deleted public reply", async () => {
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
});

test("refreshNewsScoresForPostLinks drops a link when its share is deleted", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

    await tx.delete(postTable).where(eq(postTable.id, share.id));
    await refreshNewsScoresForPostLinks(tx, share);
    const row = await readLink(tx, link.id);
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
  });
});

test("refreshNewsScores ignores null/empty link ids", async () => {
  await withRollback(async (tx) => {
    await refreshNewsScores(tx, []);
    await refreshNewsScores(tx, [null, undefined]);
    const status = await getNewsScoreStatus(tx);
    assert.deepEqual(status.scoredLinkCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Bot exclusion: shares authored by Service/Application actors (automated link
// feeds) must not surface a link as news.  Replies/quotes/reactions are not
// filtered by author; only the *sharing* post's actor type matters.
// ---------------------------------------------------------------------------

test("recomputeNewsScores excludes a Service-actor (bot) share", async () => {
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
    assert.deepEqual(result.linksUpdated, 0);
    const row = await readLink(tx, link.id);
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
    const stories = await getNewsStories(tx, { order: "popular", limit: 10 });
    assert.deepEqual(stories.find((s) => s.id === link.id), undefined);
  });
});

test("recomputeNewsScores excludes an Application-actor (bot) share", async () => {
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
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
  });
});

test("recomputeNewsScores ignores a bot share when a human also shares", async () => {
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
    assert.deepEqual(linkRow.postCount, 1);
    assertAlmostEquals(linkRow.weightedMass, baselineRow.weightedMass, 1e-9);
    assertAlmostEquals(linkRow.score, baselineRow.score, 1e-9);
    assert.deepEqual(
      linkRow.latestActivityAt?.getTime(),
      baselineRow.latestActivityAt?.getTime(),
    );
  });
});

test("recomputeNewsScores still scores a Group-actor share", async () => {
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
    assert.ok(row.latestActivityAt != null);
    assert.deepEqual(row.postCount, 1);
  });
});

test("refreshNewsScores drops a link left with only a bot share", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);
    assert.deepEqual((await readLink(tx, link.id)).postCount, 1);

    // Delete the only human share: the bot share remains but does not qualify,
    // so the incremental refresh drops the link from the feed.
    await tx.delete(postTable).where(eq(postTable.id, humanShare.id));
    await refreshNewsScores(tx, [link.id]);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.score, 0);
    assert.deepEqual(row.latestActivityAt, null);
    assert.deepEqual(row.postCount, 0);
  });
});

test("recomputeNewsScores activeSince skips a bot-only link", async () => {
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
    assert.deepEqual(result.linksUpdated, 0);
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
  });
});

test("getNewsSourceBreakdowns excludes bot shares", async () => {
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
    assert.deepEqual(breakdowns.get(link.id), {
      local: 1,
      remote: 0,
      bluesky: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Discussion count: the size of a link's federated conversation = its non-bot
// public sharing posts plus their direct public replies and quotes.
// ---------------------------------------------------------------------------

test("getNewsDiscussionCounts counts shares plus public replies and quotes", async () => {
  await withRollback(async (tx) => {
    const human = await insertAccountWithActor(tx, {
      username: "disc",
      name: "Disc",
      email: "disc@example.com",
    });
    const bot = await insertRemoteActor(tx, {
      username: "discbot",
      name: "Disc Bot",
      host: "bots.example",
      type: "Service",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/disc",
    });
    const { post: share } = await insertNotePost(tx, {
      account: human.account,
      link: { id: link.id, url: link.url },
    });
    // A bot's share of the same link must not count (excluded root).
    await insertNotePost(tx, {
      account: human.account,
      actorId: bot.id,
      link: { id: link.id, url: link.url },
    });
    // A public reply and a public quote of the human share count…
    await insertNotePost(tx, {
      account: human.account,
      replyTargetId: share.id,
    });
    await insertNotePost(tx, {
      account: human.account,
      quotedPostId: share.id,
    });
    // …but a followers-only reply does not.
    await insertNotePost(tx, {
      account: human.account,
      visibility: "followers",
      replyTargetId: share.id,
    });

    const counts = await getNewsDiscussionCounts(tx, [link.id]);
    // 1 human share + 1 public reply + 1 public quote = 3.
    assert.deepEqual(counts.get(link.id), 3);
  });
});

test("getNewsDiscussionCounts counts a share-only link and ignores unknowns", async () => {
  await withRollback(async (tx) => {
    const a = await insertAccountWithActor(tx, {
      username: "disca",
      name: "Disc A",
      email: "disca@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "discb",
      name: "Disc B",
      email: "discb@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/disc2",
    });
    await insertNotePost(tx, {
      account: a.account,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: b.account,
      link: { id: link.id, url: link.url },
    });

    const counts = await getNewsDiscussionCounts(tx, [link.id]);
    // Two shares, no replies/quotes.
    assert.deepEqual(counts.get(link.id), 2);

    // An unknown link id is simply absent from the map.
    const empty = await getNewsDiscussionCounts(tx, [
      "00000000-0000-7000-8000-000000000000" as Uuid,
    ]);
    assert.deepEqual(empty.size, 0);
  });
});

test("getNewsDiscussionCounts counts a reply-and-quote post once", async () => {
  await withRollback(async (tx) => {
    const a = await insertAccountWithActor(tx, {
      username: "dedup",
      name: "Dedup",
      email: "dedup@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/dedup",
    });
    const { post: share1 } = await insertNotePost(tx, {
      account: a.account,
      link: { id: link.id, url: link.url },
    });
    const { post: share2 } = await insertNotePost(tx, {
      account: a.account,
      link: { id: link.id, url: link.url },
    });
    // One post that both replies to share1 and quotes share2 must count once,
    // not twice, matching the deduplicated discussion tree.
    await insertNotePost(tx, {
      account: a.account,
      replyTargetId: share1.id,
      quotedPostId: share2.id,
    });

    const counts = await getNewsDiscussionCounts(tx, [link.id]);
    // 2 shares + 1 distinct child = 3 (not 4).
    assert.deepEqual(counts.get(link.id), 3);
  });
});

test("refreshNewsScoresForActor re-scores links across a bot transition", async () => {
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
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);

    // The actor toggles Mastodon's bot flag, federating as a Service: its
    // share no longer qualifies, and refreshing by actor drops the link.
    await tx.update(actorTable).set({ type: "Service" }).where(
      eq(actorTable.id, actor.id),
    );
    await refreshNewsScoresForActor(tx, actor.id);
    const botted = await readLink(tx, link.id);
    assert.deepEqual(botted.score, 0);
    assert.deepEqual(botted.latestActivityAt, null);
    assert.deepEqual(botted.postCount, 0);

    // Turning the bot flag back off re-scores the link.
    await tx.update(actorTable).set({ type: "Person" }).where(
      eq(actorTable.id, actor.id),
    );
    await refreshNewsScoresForActor(tx, actor.id);
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);
  });
});

// ---------------------------------------------------------------------------
// Repeated-share damping: the same account re-sharing the same link adds little
// extra base weight (recovering with the gap, capped below a first share) and a
// rapid repeat does not refresh freshness.  Different accounts are independent,
// and engagement on a repeat post is never discounted.
// ---------------------------------------------------------------------------

test("recomputeNewsScores damps a rapid repeat share's base mass", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "rapid",
      name: "Rapid",
      email: "rapid@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/rapid",
    });
    const t0 = new Date("2026-05-20T00:00:00.000Z");
    const t1 = new Date("2026-05-20T01:00:00.000Z"); // +1h = 3600s
    await insertNotePost(tx, {
      account: sharer.account,
      published: t0,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      link: { id: link.id, url: link.url },
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 2);
    // The second share contributes only repeatFactor(3600) of a base share.
    assertAlmostEquals(
      row.weightedMass,
      NEWS_W_SHARE * (1 + repeatFactor(3600)),
      1e-9,
    );
    // Far below two independent shares.
    assert.ok(row.weightedMass < 2 * NEWS_W_SHARE);
  });
});

test("recomputeNewsScores lets a long-gap repeat recover, but below a fresh share", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "recover",
      name: "Recover",
      email: "recover@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/recover",
    });
    const t0 = new Date("2026-02-19T00:00:00.000Z");
    const t1 = new Date("2026-05-20T00:00:00.000Z"); // +90 days
    const gap = (t1.getTime() - t0.getTime()) / 1000;
    await insertNotePost(tx, {
      account: sharer.account,
      published: t0,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      link: { id: link.id, url: link.url },
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assertAlmostEquals(
      row.weightedMass,
      NEWS_W_SHARE * (1 + repeatFactor(gap)),
      1e-9,
    );
    // The long gap recovers more than a rapid repeat would, yet a repeat is
    // always lighter than a fresh share.
    assert.ok(repeatFactor(gap) > repeatFactor(3600));
    assert.ok(repeatFactor(gap) < 1);
  });
});

test("recomputeNewsScores does not damp shares from different accounts", async () => {
  await withRollback(async (tx) => {
    const a = await insertAccountWithActor(tx, {
      username: "distincta",
      name: "Distinct A",
      email: "distincta@example.com",
    });
    const b = await insertAccountWithActor(tx, {
      username: "distinctb",
      name: "Distinct B",
      email: "distinctb@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/distinct",
    });
    // Same link, same instant, but two different accounts: both full weight.
    await insertNotePost(tx, {
      account: a.account,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: b.account,
      link: { id: link.id, url: link.url },
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 2);
    assertAlmostEquals(row.weightedMass, 2 * NEWS_W_SHARE, 1e-9);
  });
});

test("recomputeNewsScores keeps a rapid repeat from refreshing freshness", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "nopin",
      name: "No Pin",
      email: "nopin@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/nopin",
    });
    const t0 = new Date("2026-05-20T00:00:00.000Z");
    const t1 = new Date("2026-05-21T00:00:00.000Z"); // +1 day < FRESH_MIN
    assert.ok(
      (t1.getTime() - t0.getTime()) / 1000 < NEWS_REPEAT_FRESH_MIN_SECONDS,
    );
    await insertNotePost(tx, {
      account: sharer.account,
      published: t0,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      link: { id: link.id, url: link.url },
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.postCount, 2);
    // The rapid second share does not count as fresh activity.
    assert.deepEqual(row.latestActivityAt?.getTime(), t0.getTime());
  });
});

test("recomputeNewsScores lets a long-gap repeat refresh freshness", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "resurface",
      name: "Resurface",
      email: "resurface@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/resurface",
    });
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-05-21T00:00:00.000Z"); // well past FRESH_MIN
    await insertNotePost(tx, {
      account: sharer.account,
      published: t0,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      link: { id: link.id, url: link.url },
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    assert.deepEqual(row.latestActivityAt?.getTime(), t1.getTime());
  });
});

test("recomputeNewsScores still refreshes freshness from a repeat's replies", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "repreply",
      name: "Repeat Reply",
      email: "repreply@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/repreply",
    });
    const t0 = new Date("2026-05-20T00:00:00.000Z");
    const t1 = new Date("2026-05-21T00:00:00.000Z"); // gap < FRESH_MIN
    await insertNotePost(tx, {
      account: sharer.account,
      published: t0,
      link: { id: link.id, url: link.url },
    });
    const { post: repeat } = await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      link: { id: link.id, url: link.url },
    });
    // A public reply to the rapid repeat, published at t1.
    await insertNotePost(tx, {
      account: sharer.account,
      published: t1,
      replyTargetId: repeat.id,
    });

    await recomputeNewsScores(tx);

    const row = await readLink(tx, link.id);
    // The bare repeat share would not refresh freshness (gap < FRESH_MIN), but
    // its genuine reply does, so the link is fresh as of t1.
    assert.deepEqual(row.latestActivityAt?.getTime(), t1.getTime());
  });
});

// ---------------------------------------------------------------------------
// Moderation: score penalties + URL exclusions
// ---------------------------------------------------------------------------

test("setNewsScorePenalty demotes a link in the popular feed", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "penalty",
      name: "Penalty",
      email: "penalty@example.com",
    });
    const a = await insertPostLink(tx, { url: "https://example.com/pa" });
    const b = await insertPostLink(tx, { url: "https://example.com/pb" });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: sharer.account,
      published: at,
      link: { id: a.id, url: a.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      published: at,
      link: { id: b.id, url: b.url },
    });
    await recomputeNewsScores(tx);

    const baseA = (await readLink(tx, a.id)).score;
    const baseB = (await readLink(tx, b.id)).score;
    assertAlmostEquals(baseA, baseB, 1e-9); // identical base scores

    await setNewsScorePenalty(tx, a.id, NEWS_PENALTY_DEMOTE);
    const penalized = await readLink(tx, a.id);
    assert.deepEqual(penalized.scorePenalty, NEWS_PENALTY_DEMOTE);
    assertAlmostEquals(penalized.score, baseA - NEWS_PENALTY_DEMOTE, 1e-6);

    // The unpenalized peer now ranks above the demoted link.
    const popular = await getNewsStories(tx, { order: "popular", limit: 10 });
    const ai = popular.findIndex((l) => l.id === a.id);
    const bi = popular.findIndex((l) => l.id === b.id);
    assert.ok(ai >= 0 && bi >= 0 && bi < ai);

    // Clearing the penalty restores the score.
    await setNewsScorePenalty(tx, a.id, 0);
    assertAlmostEquals((await readLink(tx, a.id)).score, baseA, 1e-6);
  });
});

test("getNewsStories excludes links matching an exclusion pattern", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "excl",
      name: "Excl",
      email: "excl@example.com",
    });
    const spam = await insertPostLink(tx, { url: "https://spam.example/a" });
    const good = await insertPostLink(tx, { url: "https://good.example/b" });
    await insertNotePost(tx, {
      account: sharer.account,
      link: { id: spam.id, url: spam.url },
    });
    await insertNotePost(tx, {
      account: sharer.account,
      link: { id: good.id, url: good.url },
    });
    await recomputeNewsScores(tx);
    const before = (await getNewsStories(tx, { order: "popular", limit: 10 }))
      .map((l) => l.id);
    assert.ok(before.includes(spam.id) && before.includes(good.id));

    await addNewsExcludedPattern(tx, { pattern: "https://spam.example/*" });

    // Excluded from every sort order, but the row remains (reachable by id).
    for (const order of ["popular", "newest", "allTime"] as const) {
      const got = (await getNewsStories(tx, { order, limit: 10 }))
        .map((l) => l.id);
      assert.ok(!got.includes(spam.id), `${order} must exclude the spam link`);
      assert.ok(got.includes(good.id), `${order} must keep the good link`);
    }
    assert.deepEqual((await readLink(tx, spam.id)).excludedFromNews, true);
    assert.deepEqual((await readLink(tx, good.id)).excludedFromNews, false);

    // Removing the pattern un-flags and restores the link.
    const [pattern] = await getNewsExcludedPatterns(tx);
    await removeNewsExcludedPattern(tx, pattern.id);
    assert.deepEqual((await readLink(tx, spam.id)).excludedFromNews, false);
    const after = (await getNewsStories(tx, { order: "popular", limit: 10 }))
      .map((l) => l.id);
    assert.ok(after.includes(spam.id));
  });
});

test("recomputeNewsScores flags a newly-shared link matching a pattern", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "exclnew",
      name: "Excl New",
      email: "exclnew@example.com",
    });
    await addNewsExcludedPattern(tx, {
      pattern: "https://blocked.example/*",
    });
    const link = await insertPostLink(tx, {
      url: "https://blocked.example/post",
    });
    await insertNotePost(tx, {
      account: sharer.account,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);

    assert.deepEqual((await readLink(tx, link.id)).excludedFromNews, true);
    const ids = (await getNewsStories(tx, { order: "popular", limit: 10 }))
      .map((l) => l.id);
    assert.ok(!ids.includes(link.id));
  });
});

test("addNewsExcludedPattern rejects an invalid URLPattern", async () => {
  await withRollback(async (tx) => {
    await assert.rejects(
      () => addNewsExcludedPattern(tx, { pattern: "https://example.com/(" }),
      InvalidNewsPatternError,
    );
  });
});

test("getNewsPenalizedStories lists links carrying a penalty", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "penlist",
      name: "Pen List",
      email: "penlist@example.com",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/pl" });
    await insertNotePost(tx, {
      account: sharer.account,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);
    assert.deepEqual((await getNewsPenalizedStories(tx)).length, 0);

    await setNewsScorePenalty(tx, link.id, NEWS_PENALTY_BURY);
    const penalized = await getNewsPenalizedStories(tx);
    assert.deepEqual(penalized.length, 1);
    assert.deepEqual(penalized[0].id, link.id);

    await setNewsScorePenalty(tx, link.id, 0);
    assert.deepEqual((await getNewsPenalizedStories(tx)).length, 0);
  });
});

test("addNewsPreferredSharer adds a flat promotion bonus to a link's score", async () => {
  await withRollback(async (tx) => {
    const pref = await insertAccountWithActor(tx, {
      username: "preferred",
      name: "Preferred",
      email: "preferred@example.com",
    });
    const plain = await insertAccountWithActor(tx, {
      username: "plain",
      name: "Plain",
      email: "plain@example.com",
    });
    const a = await insertPostLink(tx, {
      url: "https://example.com/promo-a",
    });
    const b = await insertPostLink(tx, {
      url: "https://example.com/promo-b",
    });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: pref.account,
      published: at,
      link: { id: a.id, url: a.url },
    });
    await insertNotePost(tx, {
      account: plain.account,
      published: at,
      link: { id: b.id, url: b.url },
    });
    await recomputeNewsScores(tx);

    const baseA = (await readLink(tx, a.id)).score;
    const baseB = (await readLink(tx, b.id)).score;
    assertAlmostEquals(baseA, baseB, 1e-9); // identical base scores

    await addNewsPreferredSharer(tx, {
      actorId: pref.actor.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    await drainNewsRescoreQueue(tx);

    const promoted = await readLink(tx, a.id);
    assert.deepEqual(promoted.promotionBonus, NEWS_PROMOTE_NORMAL);
    assertAlmostEquals(promoted.score, baseA + NEWS_PROMOTE_NORMAL, 1e-6);
    // The peer the preferred sharer did not touch is unchanged.
    const peer = await readLink(tx, b.id);
    assert.deepEqual(peer.promotionBonus, 0);
    assertAlmostEquals(peer.score, baseB, 1e-9);

    // The promoted link now ranks above its (otherwise identical) peer.
    const popular = await getNewsStories(tx, { order: "popular", limit: 10 });
    const ai = popular.findIndex((l) => l.id === a.id);
    const bi = popular.findIndex((l) => l.id === b.id);
    assert.ok(ai >= 0 && bi >= 0 && ai < bi);
  });
});

test("a moderator penalty overrides a preferred-sharer promotion", async () => {
  await withRollback(async (tx) => {
    const pref = await insertAccountWithActor(tx, {
      username: "prefpen",
      name: "Pref Pen",
      email: "prefpen@example.com",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/pp" });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: pref.account,
      published: at,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);
    const base = (await readLink(tx, link.id)).score;

    await addNewsPreferredSharer(tx, {
      actorId: pref.actor.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    await drainNewsRescoreQueue(tx);
    assertAlmostEquals(
      (await readLink(tx, link.id)).score,
      base + NEWS_PROMOTE_NORMAL,
      1e-6,
    );

    // A penalty suppresses the promotion entirely (bonus zeroed, not netted).
    await setNewsScorePenalty(tx, link.id, NEWS_PENALTY_DEMOTE);
    const penalized = await readLink(tx, link.id);
    assert.deepEqual(penalized.promotionBonus, 0);
    assertAlmostEquals(penalized.score, base - NEWS_PENALTY_DEMOTE, 1e-6);

    // Clearing the penalty restores the promotion.
    await setNewsScorePenalty(tx, link.id, 0);
    const restored = await readLink(tx, link.id);
    assert.deepEqual(restored.promotionBonus, NEWS_PROMOTE_NORMAL);
    assertAlmostEquals(restored.score, base + NEWS_PROMOTE_NORMAL, 1e-6);
  });
});

test("a preferred sharer whitelists an otherwise-excluded bot's shares", async () => {
  await withRollback(async (tx) => {
    const host = await insertAccountWithActor(tx, {
      username: "prefbothost",
      name: "Pref Bot Host",
      email: "prefbothost@example.com",
    });
    const bot = await insertRemoteActor(tx, {
      username: "hnbot",
      name: "HN Bot",
      host: "bots.example",
      type: "Service",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/hn" });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: host.account,
      actorId: bot.id,
      published: at,
      link: { id: link.id, url: link.url },
    });

    // Without curation the bot's share is excluded from News entirely.
    await recomputeNewsScores(tx);
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);

    // Curating the bot whitelists its share and promotes the link at once.
    await addNewsPreferredSharer(tx, {
      actorId: bot.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    await drainNewsRescoreQueue(tx);
    const promoted = await readLink(tx, link.id);
    assert.deepEqual(promoted.postCount, 1);
    assert.ok(promoted.latestActivityAt != null);
    assertAlmostEquals(
      promoted.weightedMass,
      NEWS_SOURCE_WEIGHT_REMOTE,
      1e-9,
    );
    assert.deepEqual(promoted.promotionBonus, NEWS_PROMOTE_NORMAL);
    assertAlmostEquals(
      promoted.score,
      score(NEWS_SOURCE_WEIGHT_REMOTE, at) + NEWS_PROMOTE_NORMAL,
      1e-6,
    );
    // The whitelisted bot share counts toward the source breakdown too.
    const breakdowns = await getNewsSourceBreakdowns(tx, [link.id]);
    assert.deepEqual(breakdowns.get(link.id)?.remote, 1);
    assert.ok(
      (await getNewsStories(tx, { order: "popular", limit: 10 }))
        .some((l) => l.id === link.id),
    );

    // Removing the preferred sharer drops the bot-only link back out.
    const [sharer] = await getNewsPreferredSharers(tx);
    assert.deepEqual(await removeNewsPreferredSharer(tx, sharer.id), true);
    await drainNewsRescoreQueue(tx);
    const dropped = await readLink(tx, link.id);
    assert.deepEqual(dropped.latestActivityAt, null);
    assert.deepEqual(dropped.score, 0);
    assert.deepEqual(dropped.promotionBonus, 0);
    assert.deepEqual(dropped.postCount, 0);
    assert.deepEqual(
      (await getNewsStories(tx, { order: "popular", limit: 10 }))
        .find((l) => l.id === link.id),
      undefined,
    );
  });
});

test("the strongest preferred-sharer bonus wins (max, not sum)", async () => {
  await withRollback(async (tx) => {
    const weak = await insertAccountWithActor(tx, {
      username: "weakpref",
      name: "Weak Pref",
      email: "weakpref@example.com",
    });
    const strong = await insertAccountWithActor(tx, {
      username: "strongpref",
      name: "Strong Pref",
      email: "strongpref@example.com",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/max" });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: weak.account,
      published: at,
      link: { id: link.id, url: link.url },
    });
    await insertNotePost(tx, {
      account: strong.account,
      published: at,
      link: { id: link.id, url: link.url },
    });
    await addNewsPreferredSharer(tx, {
      actorId: weak.actor.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    await addNewsPreferredSharer(tx, {
      actorId: strong.actor.id,
      bonus: NEWS_PROMOTE_STRONG,
    });
    await drainNewsRescoreQueue(tx);

    // The link carries the larger bonus, not the sum of the two.
    assert.deepEqual(
      (await readLink(tx, link.id)).promotionBonus,
      NEWS_PROMOTE_STRONG,
    );
  });
});

test("re-adding a preferred sharer updates its bonus in place", async () => {
  await withRollback(async (tx) => {
    const pref = await insertAccountWithActor(tx, {
      username: "readdpref",
      name: "Re-add Pref",
      email: "readdpref@example.com",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/re" });
    const at = new Date("2026-05-20T00:00:00.000Z");
    await insertNotePost(tx, {
      account: pref.account,
      published: at,
      link: { id: link.id, url: link.url },
    });

    await addNewsPreferredSharer(tx, {
      actorId: pref.actor.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    await drainNewsRescoreQueue(tx);
    assert.deepEqual(
      (await readLink(tx, link.id)).promotionBonus,
      NEWS_PROMOTE_NORMAL,
    );

    await addNewsPreferredSharer(tx, {
      actorId: pref.actor.id,
      bonus: NEWS_PROMOTE_STRONG,
      note: "bumped",
    });
    await drainNewsRescoreQueue(tx);
    // One row per actor, with the updated bonus reflected in the score.
    const sharers = await getNewsPreferredSharers(tx);
    assert.deepEqual(sharers.length, 1);
    assert.deepEqual(sharers[0].bonus, NEWS_PROMOTE_STRONG);
    assert.deepEqual(sharers[0].note, "bumped");
    assert.deepEqual(
      (await readLink(tx, link.id)).promotionBonus,
      NEWS_PROMOTE_STRONG,
    );
  });
});

test("addNewsPreferredSharer rejects a non-positive bonus", async () => {
  await withRollback(async (tx) => {
    const pref = await insertAccountWithActor(tx, {
      username: "badbonus",
      name: "Bad Bonus",
      email: "badbonus@example.com",
    });
    await assert.rejects(
      () => addNewsPreferredSharer(tx, { actorId: pref.actor.id, bonus: 0 }),
      RangeError,
    );
  });
});

test("addNewsPreferredSharer defers the rescore to drainNewsRescoreQueue", async () => {
  await withRollback(async (tx) => {
    const host = await insertAccountWithActor(tx, {
      username: "deferhost",
      name: "Defer Host",
      email: "deferhost@example.com",
    });
    const bot = await insertRemoteActor(tx, {
      username: "deferbot",
      name: "Defer Bot",
      host: "bots.example",
      type: "Service",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/df" });
    await insertNotePost(tx, {
      account: host.account,
      actorId: bot.id,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);

    // Adding the sharer enqueues the actor but does NOT score the link yet.
    await addNewsPreferredSharer(tx, {
      actorId: bot.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
    const queued = await tx.select().from(newsRescoreQueueTable);
    assert.deepEqual(queued.length, 1);
    assert.deepEqual(queued[0].actorId, bot.id);

    // Draining performs the deferred rescore and clears the queue.
    const result = await drainNewsRescoreQueue(tx);
    assert.deepEqual(result.actorsProcessed, 1);
    assert.ok(result.linksRecomputed >= 1);
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);
    assert.deepEqual(
      (await tx.select().from(newsRescoreQueueTable)).length,
      0,
    );

    // A second drain with an empty queue is a no-op.
    assert.deepEqual(
      (await drainNewsRescoreQueue(tx)).actorsProcessed,
      0,
    );
  });
});

test("drainNewsRescoreQueue skips a leased actor until the lease expires", async () => {
  await withRollback(async (tx) => {
    const host = await insertAccountWithActor(tx, {
      username: "leasehost",
      name: "Lease Host",
      email: "leasehost@example.com",
    });
    const bot = await insertRemoteActor(tx, {
      username: "leasebot",
      name: "Lease Bot",
      host: "bots.example",
      type: "Service",
    });
    const link = await insertPostLink(tx, { url: "https://example.com/ls" });
    await insertNotePost(tx, {
      account: host.account,
      actorId: bot.id,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);
    await addNewsPreferredSharer(tx, {
      actorId: bot.id,
      bonus: NEWS_PROMOTE_NORMAL,
    });

    // Simulate another replica holding a fresh lease on this actor: a drain
    // must leave it alone (no double processing) and the link stays unscored.
    await tx
      .update(newsRescoreQueueTable)
      .set({ claimedAt: new Date() })
      .where(eq(newsRescoreQueueTable.actorId, bot.id));
    assert.deepEqual((await drainNewsRescoreQueue(tx)).actorsProcessed, 0);
    assert.deepEqual((await readLink(tx, link.id)).latestActivityAt, null);
    assert.deepEqual((await tx.select().from(newsRescoreQueueTable)).length, 1);

    // Once the lease is stale (the holder crashed), a drain reclaims it.
    await tx
      .update(newsRescoreQueueTable)
      .set({ claimedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(newsRescoreQueueTable.actorId, bot.id));
    assert.deepEqual((await drainNewsRescoreQueue(tx)).actorsProcessed, 1);
    assert.ok((await readLink(tx, link.id)).latestActivityAt != null);
    assert.deepEqual((await tx.select().from(newsRescoreQueueTable)).length, 0);
  });
});

test("enqueueNewsRescore marks an already-queued actor dirty", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "dirtyq",
      name: "Dirty Q",
      email: "dirtyq@example.com",
    });
    // First enqueue creates a clean pending row.
    await enqueueNewsRescore(tx, actor.actor.id);
    const [first] = await tx
      .select()
      .from(newsRescoreQueueTable)
      .where(eq(newsRescoreQueueTable.actorId, actor.actor.id));
    assert.deepEqual(first.dirty, false);

    // A second enqueue (a re-add/remove) marks the existing row dirty, so a
    // worker already processing it will reopen and rescore again.
    await enqueueNewsRescore(tx, actor.actor.id);
    const rows = await tx
      .select()
      .from(newsRescoreQueueTable)
      .where(eq(newsRescoreQueueTable.actorId, actor.actor.id));
    assert.deepEqual(rows.length, 1);
    assert.deepEqual(rows[0].dirty, true);
  });
});

import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import {
  drainNewsRescoreQueue,
  recomputeNewsScores,
} from "@hackerspub/models/news";
import { accountTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { Transaction } from "@hackerspub/models/db";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
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

const newsStoriesQuery = parse(`
  query NewsStories($order: NewsOrder, $first: Int, $after: String) {
    newsStories(order: $order, first: $first, after: $after) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        endCursor
      }
      edges {
        cursor
        node {
          url
          score
          weightedMass
          postCount
        }
      }
    }
  }
`);

interface NewsStoriesResult {
  newsStories: {
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      endCursor: string | null;
    };
    edges: { cursor: string; node: { url: string } }[];
  };
}

Deno.test({
  name: "newsStories ranks links by score for a guest, popular by default",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "gqlnews",
        name: "GQL News",
        email: "gqlnews@example.com",
      });
      const high = await insertPostLink(tx, {
        url: "https://example.com/high",
      });
      const low = await insertPostLink(tx, { url: "https://example.com/low" });
      await insertNotePost(tx, {
        account: sharer.account,
        reactionsCounts: { "❤️": 10 },
        published: new Date("2026-05-20T00:00:00.000Z"),
        link: { id: high.id, url: high.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2026-05-20T00:00:00.000Z"),
        link: { id: low.id, url: low.url },
      });
      await recomputeNewsScores(tx);

      const result = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const data = result.data as unknown as NewsStoriesResult;
      assertEquals(data.newsStories.edges.map((e) => e.node.url), [
        high.url,
        low.url,
      ]);
    });
  },
});

Deno.test({
  name: "newsStories order arg switches between popular, newest, and allTime",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "gqlorder",
        name: "GQL Order",
        email: "gqlorder@example.com",
      });
      const heavyOld = await insertPostLink(tx, {
        url: "https://example.com/heavy",
      });
      const lightNew = await insertPostLink(tx, {
        url: "https://example.com/light",
      });
      await insertNotePost(tx, {
        account: sharer.account,
        reactionsCounts: { "❤️": 100 },
        published: new Date("2025-05-30T00:00:00.000Z"),
        link: { id: heavyOld.id, url: heavyOld.url },
      });
      await insertNotePost(tx, {
        account: sharer.account,
        published: new Date("2026-05-30T00:00:00.000Z"),
        link: { id: lightNew.id, url: lightNew.url },
      });
      await recomputeNewsScores(tx);

      const firstUrl = async (order: string) => {
        const result = await execute({
          schema,
          document: newsStoriesQuery,
          variableValues: { order, first: 10 },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assertEquals(result.errors, undefined);
        return (result.data as unknown as NewsStoriesResult)
          .newsStories.edges[0].node.url;
      };

      assertEquals(await firstUrl("POPULAR"), lightNew.url);
      assertEquals(await firstUrl("NEWEST"), lightNew.url);
      assertEquals(await firstUrl("ALL_TIME"), heavyOld.url);
    });
  },
});

Deno.test({
  name: "newsStories paginates forward by cursor without gaps",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "gqlpage",
        name: "GQL Page",
        email: "gqlpage@example.com",
      });
      const urls: string[] = [];
      for (let i = 0; i < 3; i++) {
        const link = await insertPostLink(tx, {
          url: `https://example.com/p${i}`,
        });
        await insertNotePost(tx, {
          account: sharer.account,
          reactionsCounts: { "❤️": i + 1 }, // distinct scores
          published: new Date("2026-05-20T00:00:00.000Z"),
          link: { id: link.id, url: link.url },
        });
        urls.push(link.url);
      }
      await recomputeNewsScores(tx);

      const page1 = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 2 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(page1.errors, undefined);
      const data1 = page1.data as unknown as NewsStoriesResult;
      assertEquals(data1.newsStories.edges.length, 2);
      assert(data1.newsStories.pageInfo.hasNextPage);

      const page2 = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: {
          first: 2,
          after: data1.newsStories.pageInfo.endCursor,
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(page2.errors, undefined);
      const data2 = page2.data as unknown as NewsStoriesResult;
      assert(data2.newsStories.pageInfo.hasPreviousPage);

      const seen = [...data1.newsStories.edges, ...data2.newsStories.edges]
        .map((e) => e.node.url);
      assertEquals(new Set(seen).size, 3);
      // Highest score (most reactions) first.
      assertEquals(seen[0], urls[2]);
      assertEquals(seen[2], urls[0]);
    });
  },
});

Deno.test({
  name: "newsStories rejects pages larger than the cap",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const tooBig = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 101 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert(tooBig.errors != null && tooBig.errors.length > 0);
      assertEquals(tooBig.errors[0].extensions?.code, "PAGINATION_ERROR");
    });
  },
});

Deno.test({
  name: "PostLink exposes sharingPosts and sourceBreakdown",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "gqllocal",
        name: "GQL Local",
        email: "gqllocal@example.com",
      });
      const remote = await insertRemoteActor(tx, {
        username: "gqlremote",
        name: "GQL Remote",
        host: "mastodon.example",
      });
      const bridged = await insertRemoteActor(tx, {
        username: "gqlbsky.bsky.social",
        name: "GQL Bsky",
        host: "bsky.brid.gy",
        handleHost: "bsky.brid.gy",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/mix" });
      await insertNotePost(tx, {
        account: local.account,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: local.account,
        actorId: remote.id,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: local.account,
        actorId: bridged.id,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);

      const result = await execute({
        schema,
        document: parse(`
          query {
            newsStories(first: 10) {
              edges {
                node {
                  url
                  postCount
                  sourceBreakdown { local remote bluesky }
                  sharingPosts(first: 10) {
                    edges { node { __typename } }
                  }
                }
              }
            }
          }
        `),
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const node = (result.data as {
        newsStories: {
          edges: {
            node: {
              url: string;
              postCount: number;
              sourceBreakdown: {
                local: number;
                remote: number;
                bluesky: number;
              };
              sharingPosts: { edges: unknown[] };
            };
          }[];
        };
      }).newsStories.edges[0].node;
      assertEquals(node.url, link.url);
      assertEquals(node.postCount, 3);
      assertEquals(node.sourceBreakdown, { local: 1, remote: 1, bluesky: 1 });
      assertEquals(node.sharingPosts.edges.length, 3);
    });
  },
});

Deno.test({
  name: "sharingPosts and postCount exclude bot-account shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "gqlbothuman",
        name: "GQL Human",
        email: "gqlbothuman@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "gqlbot",
        name: "GQL Bot",
        host: "bots.example",
        type: "Application",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/botmix",
      });
      await insertNotePost(tx, {
        account: local.account,
        link: { id: link.id, url: link.url },
      });
      // A bot's share of the same link must not become a discussion root nor
      // inflate the public share count.
      await insertNotePost(tx, {
        account: local.account,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);

      const result = await execute({
        schema,
        document: parse(`
          query {
            newsStories(first: 10) {
              edges {
                node {
                  url
                  postCount
                  sourceBreakdown { local remote bluesky }
                  sharingPosts(first: 10) {
                    edges { node { __typename } }
                  }
                }
              }
            }
          }
        `),
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const node = (result.data as {
        newsStories: {
          edges: {
            node: {
              url: string;
              postCount: number;
              sourceBreakdown: {
                local: number;
                remote: number;
                bluesky: number;
              };
              sharingPosts: { edges: unknown[] };
            };
          }[];
        };
      }).newsStories.edges[0].node;
      assertEquals(node.url, link.url);
      assertEquals(node.postCount, 1);
      assertEquals(node.sourceBreakdown, { local: 1, remote: 0, bluesky: 0 });
      assertEquals(node.sharingPosts.edges.length, 1);
    });
  },
});

Deno.test({
  name: "newsStories omits a link shared only by a bot account",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const host = await insertAccountWithActor(tx, {
        username: "gqlbotonly",
        name: "GQL Bot Only",
        email: "gqlbotonly@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "gqlonlybot",
        name: "GQL Only Bot",
        host: "bots.example",
        type: "Service",
      });
      const humanLink = await insertPostLink(tx, {
        url: "https://example.com/gqlhuman",
      });
      const botLink = await insertPostLink(tx, {
        url: "https://example.com/gqlbotonly",
      });
      await insertNotePost(tx, {
        account: host.account,
        link: { id: humanLink.id, url: humanLink.url },
      });
      await insertNotePost(tx, {
        account: host.account,
        actorId: bot.id,
        link: { id: botLink.id, url: botLink.url },
      });
      await recomputeNewsScores(tx);

      const result = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const urls = (result.data as unknown as NewsStoriesResult)
        .newsStories.edges.map((e) => e.node.url);
      assert(urls.includes(humanLink.url));
      assert(!urls.includes(botLink.url));
    });
  },
});

Deno.test({
  name: "PostLink discussionCount counts shares plus public replies and quotes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const human = await insertAccountWithActor(tx, {
        username: "gqldisc",
        name: "GQL Disc",
        email: "gqldisc@example.com",
      });
      const link = await insertPostLink(tx, {
        url: "https://example.com/gqldisc",
      });
      const { post: share } = await insertNotePost(tx, {
        account: human.account,
        link: { id: link.id, url: link.url },
      });
      await insertNotePost(tx, {
        account: human.account,
        replyTargetId: share.id,
      });
      await insertNotePost(tx, {
        account: human.account,
        quotedPostId: share.id,
      });
      // A followers-only reply must not inflate the public count.
      await insertNotePost(tx, {
        account: human.account,
        visibility: "followers",
        replyTargetId: share.id,
      });
      await recomputeNewsScores(tx);

      const result = await execute({
        schema,
        document: parse(`
          query Q($id: UUID!) {
            newsStory(id: $id) { discussionCount }
          }
        `),
        variableValues: { id: link.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as { newsStory: { discussionCount: number } | null })
          .newsStory?.discussionCount,
        3,
      );
    });
  },
});

Deno.test({
  name: "newsStories rejects backward pagination",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const result = await execute({
        schema,
        document: parse(`
          query {
            newsStories(last: 5) {
              edges { node { url } }
            }
          }
        `),
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert(result.errors != null && result.errors.length > 0);
      assertEquals(result.errors[0].extensions?.code, "PAGINATION_ERROR");
    });
  },
});

const statusQuery = parse(`
  query NewsScoreStatus {
    newsScoreStatus {
      scoredLinkCount
      lastRecomputedAt
    }
  }
`);

Deno.test({
  name: "newsStory looks a link up by uuid for the discussion permalink",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const sharer = await insertAccountWithActor(tx, {
        username: "storylookup",
        name: "Story Lookup",
        email: "storylookup@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/by" });
      await insertNotePost(tx, {
        account: sharer.account,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);

      const doc = parse(`
        query Story($id: UUID!) {
          newsStory(id: $id) { uuid url postCount }
        }
      `);
      const found = await execute({
        schema,
        document: doc,
        variableValues: { id: link.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(found.errors, undefined);
      const story = (found.data as {
        newsStory: { uuid: string; url: string; postCount: number } | null;
      }).newsStory;
      assertEquals(story?.uuid, link.id);
      assertEquals(story?.url, link.url);
      assertEquals(story?.postCount, 1);

      // A well-formed but unknown uuid resolves to null (not an error).
      const missing = await execute({
        schema,
        document: doc,
        variableValues: { id: "00000000-0000-7000-8000-000000000000" },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(missing.errors, undefined);
      assertEquals(
        (missing.data as { newsStory: unknown }).newsStory,
        null,
      );
    });
  },
});

Deno.test({
  name: "newsScoreStatus is null for guests and non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const guest = await execute({
        schema,
        document: statusQuery,
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guest.errors, undefined);
      assertEquals(
        (guest.data as { newsScoreStatus: unknown }).newsScoreStatus,
        null,
      );

      const { account } = await insertAccountWithActor(tx, {
        username: "plainviewer",
        name: "Plain Viewer",
        email: "plainviewer@example.com",
      });
      const nonMod = await execute({
        schema,
        document: statusQuery,
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(nonMod.errors, undefined);
      assertEquals(
        (nonMod.data as { newsScoreStatus: unknown }).newsScoreStatus,
        null,
      );
    });
  },
});

const recomputeMutation = parse(`
  mutation Recompute {
    recomputeNewsScores {
      __typename
      ... on RecomputeNewsScoresPayload {
        linksUpdated
        status { scoredLinkCount lastRecomputedAt }
      }
    }
  }
`);

Deno.test({
  name: "recomputeNewsScores rejects guests and non-moderators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const guest = await execute({
        schema,
        document: recomputeMutation,
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guest.errors, undefined);
      assertEquals(
        (guest.data as { recomputeNewsScores: { __typename: string } })
          .recomputeNewsScores.__typename,
        "NotAuthenticatedError",
      );

      const { account } = await insertAccountWithActor(tx, {
        username: "nonmod",
        name: "Non Mod",
        email: "nonmod@example.com",
      });
      const nonMod = await execute({
        schema,
        document: recomputeMutation,
        contextValue: makeUserContext(tx, account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(nonMod.errors, undefined);
      assertEquals(
        (nonMod.data as { recomputeNewsScores: { __typename: string } })
          .recomputeNewsScores.__typename,
        "NotAuthorizedError",
      );
    });
  },
});

Deno.test({
  name: "recomputeNewsScores rebuilds scores for a moderator",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx, {
        username: "newsmod",
        name: "News Mod",
        email: "newsmod@example.com",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/mod" });
      await insertNotePost(tx, {
        account: moderator,
        link: { id: link.id, url: link.url },
      });
      // Note: the incremental write hook already scored the link, but the
      // mutation must still report a consistent post-run status.

      const result = await execute({
        schema,
        document: recomputeMutation,
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(result.errors, undefined);
      const payload = (result.data as {
        recomputeNewsScores: {
          __typename: string;
          linksUpdated: number;
          status: { scoredLinkCount: number; lastRecomputedAt: string | null };
        };
      }).recomputeNewsScores;
      assertEquals(payload.__typename, "RecomputeNewsScoresPayload");
      assertEquals(payload.linksUpdated, 1);
      assertEquals(payload.status.scoredLinkCount, 1);
      assert(payload.status.lastRecomputedAt != null);

      // The feed now lists the recomputed story.
      const feed = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(feed.errors, undefined);
      assertEquals(
        (feed.data as unknown as NewsStoriesResult).newsStories.edges[0].node
          .url,
        link.url,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// Moderation: score penalty + URL exclusions
// ---------------------------------------------------------------------------

const setPenaltyMutation = parse(`
  mutation SetPenalty($id: UUID!, $penalty: NewsPenalty!) {
    setNewsScorePenalty(id: $id, penalty: $penalty) {
      __typename
      ... on PostLink { uuid penalty }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

function penaltyTypename(data: unknown): string {
  return (data as { setNewsScorePenalty: { __typename: string } })
    .setNewsScorePenalty.__typename;
}

Deno.test({
  name: "setNewsScorePenalty demotes for a moderator and rejects others",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx, {
        username: "penmod",
        name: "Pen Mod",
        email: "penmod@example.com",
      });
      const a = await insertPostLink(tx, { url: "https://example.com/pena" });
      const b = await insertPostLink(tx, { url: "https://example.com/penb" });
      const at = new Date("2026-05-20T00:00:00.000Z");
      await insertNotePost(tx, {
        account: moderator,
        published: at,
        link: { id: a.id, url: a.url },
      });
      await insertNotePost(tx, {
        account: moderator,
        published: at,
        link: { id: b.id, url: b.url },
      });
      await recomputeNewsScores(tx);

      // Guest and non-moderator are rejected.
      const guest = await execute({
        schema,
        document: setPenaltyMutation,
        variableValues: { id: a.id, penalty: "DEMOTE" },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guest.errors, undefined);
      assertEquals(penaltyTypename(guest.data), "NotAuthenticatedError");

      const { account: plain } = await insertAccountWithActor(tx, {
        username: "penplain",
        name: "Pen Plain",
        email: "penplain@example.com",
      });
      const nonMod = await execute({
        schema,
        document: setPenaltyMutation,
        variableValues: { id: a.id, penalty: "DEMOTE" },
        contextValue: makeUserContext(tx, plain),
        onError: "NO_PROPAGATE",
      });
      assertEquals(nonMod.errors, undefined);
      assertEquals(penaltyTypename(nonMod.data), "NotAuthorizedError");

      // A moderator demotes link A.
      const set = await execute({
        schema,
        document: setPenaltyMutation,
        variableValues: { id: a.id, penalty: "DEMOTE" },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(set.errors, undefined);
      const payload = (set.data as {
        setNewsScorePenalty: { __typename: string; penalty: string };
      }).setNewsScorePenalty;
      assertEquals(payload.__typename, "PostLink");
      assertEquals(payload.penalty, "DEMOTE");

      // The unpenalized peer now ranks above the demoted link in POPULAR.
      const feed = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(feed.errors, undefined);
      const urls = (feed.data as unknown as NewsStoriesResult).newsStories.edges
        .map((e) => e.node.url);
      assert(urls.indexOf(b.url) < urls.indexOf(a.url));
    });
  },
});

const addPatternMutation = parse(`
  mutation AddPattern($pattern: String!, $note: String) {
    addNewsExcludedPattern(pattern: $pattern, note: $note) {
      __typename
      ... on NewsExcludedPattern { id pattern note }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);
const patternsQuery = parse(
  `query { newsExcludedPatterns { id pattern note } }`,
);
const removePatternMutation = parse(`
  mutation RemovePattern($id: UUID!) {
    removeNewsExcludedPattern(id: $id) {
      __typename
      ... on RemoveNewsExcludedPatternPayload { removedId }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

Deno.test({
  name: "news exclusion patterns hide links and are moderator-only",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx, {
        username: "exclmod",
        name: "Excl Mod",
        email: "exclmod@example.com",
      });
      const spam = await insertPostLink(tx, { url: "https://spam.example/x" });
      const good = await insertPostLink(tx, { url: "https://good.example/y" });
      await insertNotePost(tx, {
        account: moderator,
        link: { id: spam.id, url: spam.url },
      });
      await insertNotePost(tx, {
        account: moderator,
        link: { id: good.id, url: good.url },
      });
      await recomputeNewsScores(tx);

      // Guests cannot add patterns or read the list.
      const guestAdd = await execute({
        schema,
        document: addPatternMutation,
        variableValues: { pattern: "https://spam.example/*", note: null },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (guestAdd.data as { addNewsExcludedPattern: { __typename: string } })
          .addNewsExcludedPattern.__typename,
        "NotAuthenticatedError",
      );
      const guestList = await execute({
        schema,
        document: patternsQuery,
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (guestList.data as { newsExcludedPatterns: unknown })
          .newsExcludedPatterns,
        null,
      );

      // An invalid pattern is an InvalidInputError.
      const bad = await execute({
        schema,
        document: addPatternMutation,
        variableValues: { pattern: "https://example.com/(", note: null },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (bad.data as { addNewsExcludedPattern: { __typename: string } })
          .addNewsExcludedPattern.__typename,
        "InvalidInputError",
      );

      // A moderator adds a valid pattern; the spam link leaves the feed.
      const add = await execute({
        schema,
        document: addPatternMutation,
        variableValues: { pattern: "https://spam.example/*", note: "spam" },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      const added = (add.data as {
        addNewsExcludedPattern: { __typename: string; id: string };
      }).addNewsExcludedPattern;
      assertEquals(added.__typename, "NewsExcludedPattern");

      const feed = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      const urls = (feed.data as unknown as NewsStoriesResult).newsStories.edges
        .map((e) => e.node.url);
      assert(!urls.includes(spam.url));
      assert(urls.includes(good.url));

      // Removing the pattern restores the link.
      const remove = await execute({
        schema,
        document: removePatternMutation,
        variableValues: { id: added.id },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (remove.data as {
          removeNewsExcludedPattern: { __typename: string; removedId: string };
        }).removeNewsExcludedPattern.removedId,
        added.id,
      );
      const feed2 = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      const urls2 = (feed2.data as unknown as NewsStoriesResult).newsStories
        .edges.map((e) => e.node.url);
      assert(urls2.includes(spam.url));
    });
  },
});

const addPreferredMutation = parse(`
  mutation AddPreferred($actorId: UUID!, $promotion: NewsPromotion, $note: String) {
    addNewsPreferredSharer(actorId: $actorId, promotion: $promotion, note: $note) {
      __typename
      ... on NewsPreferredSharer { id promotion note actor { uuid } }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);
const preferredQuery = parse(
  `query { newsPreferredSharers { id promotion actor { uuid } } }`,
);
const removePreferredMutation = parse(`
  mutation RemovePreferred($id: UUID!) {
    removeNewsPreferredSharer(id: $id) {
      __typename
      ... on RemoveNewsPreferredSharerPayload { removedId }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
    }
  }
`);

Deno.test({
  name: "preferred sharers whitelist a bot's link and are moderator-only",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx, {
        username: "prefmod",
        name: "Pref Mod",
        email: "prefmod@example.com",
      });
      const bot = await insertRemoteActor(tx, {
        username: "hnfeed",
        name: "HN Feed",
        host: "bots.example",
        type: "Service",
      });
      const link = await insertPostLink(tx, { url: "https://example.com/hn" });
      await insertNotePost(tx, {
        account: moderator,
        actorId: bot.id,
        link: { id: link.id, url: link.url },
      });
      await recomputeNewsScores(tx);

      // The bot's share is excluded from the feed before any curation.
      const before = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert(
        !(before.data as unknown as NewsStoriesResult).newsStories.edges
          .some((e) => e.node.url === link.url),
      );

      // Guests cannot curate or read the list.
      const guestAdd = await execute({
        schema,
        document: addPreferredMutation,
        variableValues: { actorId: bot.id, promotion: "STRONG", note: null },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (guestAdd.data as { addNewsPreferredSharer: { __typename: string } })
          .addNewsPreferredSharer.__typename,
        "NotAuthenticatedError",
      );
      const guestList = await execute({
        schema,
        document: preferredQuery,
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (guestList.data as { newsPreferredSharers: unknown })
          .newsPreferredSharers,
        null,
      );

      // A non-moderator is rejected too.
      const { account: plain } = await insertAccountWithActor(tx, {
        username: "prefplain",
        name: "Pref Plain",
        email: "prefplain@example.com",
      });
      const nonMod = await execute({
        schema,
        document: addPreferredMutation,
        variableValues: { actorId: bot.id, promotion: "STRONG", note: null },
        contextValue: makeUserContext(tx, plain),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (nonMod.data as { addNewsPreferredSharer: { __typename: string } })
          .addNewsPreferredSharer.__typename,
        "NotAuthorizedError",
      );

      // An unknown actor id is an InvalidInputError.
      const bogus = await execute({
        schema,
        document: addPreferredMutation,
        variableValues: {
          actorId: "00000000-0000-7000-8000-000000000000",
          promotion: "STRONG",
          note: null,
        },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (bogus.data as { addNewsPreferredSharer: { __typename: string } })
          .addNewsPreferredSharer.__typename,
        "InvalidInputError",
      );

      // A moderator curates the bot; its link enters the feed.
      const add = await execute({
        schema,
        document: addPreferredMutation,
        variableValues: { actorId: bot.id, promotion: "STRONG", note: "HN" },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(add.errors, undefined);
      const added = (add.data as {
        addNewsPreferredSharer: {
          __typename: string;
          id: string;
          promotion: string;
          actor: { uuid: string };
        };
      }).addNewsPreferredSharer;
      assertEquals(added.__typename, "NewsPreferredSharer");
      assertEquals(added.promotion, "STRONG");
      assertEquals(added.actor.uuid, bot.id);

      // The mutation only enqueues the rescore; the worker's drain (run inline
      // here) is what whitelists the bot's link into the feed.
      await drainNewsRescoreQueue(tx);
      const feed = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert(
        (feed.data as unknown as NewsStoriesResult).newsStories.edges
          .some((e) => e.node.url === link.url),
      );

      // The moderator can read the curated list.
      const list = await execute({
        schema,
        document: preferredQuery,
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      const sharers = (list.data as {
        newsPreferredSharers: { id: string; promotion: string }[];
      }).newsPreferredSharers;
      assertEquals(sharers.length, 1);
      assertEquals(sharers[0].promotion, "STRONG");

      // Removing the curation drops the bot-only link back out.
      const remove = await execute({
        schema,
        document: removePreferredMutation,
        variableValues: { id: added.id },
        contextValue: makeUserContext(tx, moderator),
        onError: "NO_PROPAGATE",
      });
      assertEquals(
        (remove.data as {
          removeNewsPreferredSharer: { removedId: string };
        }).removeNewsPreferredSharer.removedId,
        added.id,
      );
      await drainNewsRescoreQueue(tx);
      const feed2 = await execute({
        schema,
        document: newsStoriesQuery,
        variableValues: { first: 10 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert(
        !(feed2.data as unknown as NewsStoriesResult).newsStories.edges
          .some((e) => e.node.url === link.url),
      );
    });
  },
});

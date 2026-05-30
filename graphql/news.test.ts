import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { recomputeNewsScores } from "@hackerspub/models/news";
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
        quotesCount: 10,
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
        quotesCount: 50,
        repliesCount: 50,
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
          quotesCount: i, // distinct scores
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
      // Highest score (quotesCount 2) first.
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

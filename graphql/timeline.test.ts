import { assertEquals } from "@std/assert/equals";
import { eq } from "drizzle-orm";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { sharePost } from "@hackerspub/models/post";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";
import { postTable } from "@hackerspub/models/schema";

const publicTimelineQuery = parse(`
  query PublicTimelineTest(
    $first: Int
    $local: Boolean
    $withoutShares: Boolean
  ) {
    publicTimeline(
      first: $first
      local: $local
      withoutShares: $withoutShares
    ) {
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          id
        }
      }
    }
  }
`);

const personalTimelineQuery = parse(`
  query PersonalTimelineTest($withoutShares: Boolean) {
    personalTimeline(first: 10, withoutShares: $withoutShares) {
      edges {
        node {
          id
        }
        lastSharer {
          id
        }
        sharersCount
      }
    }
  }
`);

Deno.test({
  name: "publicTimeline exposes forward pagination metadata",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const localAuthor = await insertAccountWithActor(tx, {
        username: "graphqltimelineauthor",
        name: "GraphQL Timeline Author",
        email: "graphqltimelineauthor@example.com",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: localAuthor.account,
        content: "Local timeline post",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "graphqltimeremote",
        name: "GraphQL Timeline Remote",
        host: "graphql.timeline.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Remote timeline post</p>",
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:01.000Z"),
          updated: new Date("2026-04-15T00:00:01.000Z"),
        })
        .where(eq(postTable.id, localPost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:02.000Z"),
          updated: new Date("2026-04-15T00:00:02.000Z"),
        })
        .where(eq(postTable.id, remotePost.id));

      const result = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: { first: 1 },
        contextValue: makeUserContext(tx, localAuthor.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const connection = (result.data as {
        publicTimeline: {
          pageInfo: { hasNextPage: boolean };
          edges: { node: { id: string } }[];
        };
      }).publicTimeline;

      assertEquals(connection.pageInfo.hasNextPage, true);
      assertEquals(connection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", remotePost.id),
      ]);
    });
  },
});

Deno.test({
  name: "publicTimeline and personalTimeline honor share filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const localAuthor = await insertAccountWithActor(tx, {
        username: "graphqllocalfilterauthor",
        name: "GraphQL Local Filter Author",
        email: "graphqllocalfilterauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "graphqltimelinefiltersharer",
        name: "GraphQL Timeline Filter Sharer",
        email: "graphqltimelinefiltersharer@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqltimelinefilterviewer",
        name: "GraphQL Timeline Filter Viewer",
        email: "graphqltimelinefilterviewer@example.com",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: localAuthor.account,
        content: "Filtered local post",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "graphqltimelinefilterremote",
        name: "GraphQL Timeline Filter Remote",
        host: "timeline-filter.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Filtered remote post</p>",
      });

      await follow(fedCtx, viewer.account, sharer.actor);
      const share = await sharePost(fedCtx, sharer.account, {
        ...remotePost,
        actor: remoteActor,
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:01.000Z"),
          updated: new Date("2026-04-15T00:00:01.000Z"),
        })
        .where(eq(postTable.id, localPost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:02.000Z"),
          updated: new Date("2026-04-15T00:00:02.000Z"),
        })
        .where(eq(postTable.id, remotePost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:03.000Z"),
          updated: new Date("2026-04-15T00:00:03.000Z"),
        })
        .where(eq(postTable.id, share.id));

      const publicResult = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: {
          first: 10,
          local: true,
          withoutShares: true,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(publicResult.errors, undefined);
      assertEquals(
        (publicResult.data as {
          publicTimeline: { edges: { node: { id: string } }[] };
        }).publicTimeline.edges.map((edge) => edge.node.id),
        [encodeGlobalID("Note", localPost.id)],
      );

      const personalResult = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { withoutShares: false },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(personalResult.errors, undefined);

      const personalEdges = (personalResult.data as {
        personalTimeline: {
          edges: {
            node: { id: string };
            lastSharer: { id: string } | null;
            sharersCount: number;
          }[];
        };
      }).personalTimeline.edges;
      assertEquals(personalEdges.length, 1);
      assertEquals(
        personalEdges[0].node.id,
        encodeGlobalID("Note", remotePost.id),
      );
      assertEquals(
        personalEdges[0].lastSharer?.id,
        encodeGlobalID("Actor", sharer.actor.id),
      );
      assertEquals(personalEdges[0].sharersCount, 1);

      const withoutSharesResult = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { withoutShares: true },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(withoutSharesResult.errors, undefined);
      assertEquals(
        (withoutSharesResult.data as {
          personalTimeline: { edges: unknown[] };
        }).personalTimeline.edges,
        [],
      );
    });
  },
});

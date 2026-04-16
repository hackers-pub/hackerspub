import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { notificationTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const notificationActorsQuery = parse(`
  query NotificationActorsOrderQuery {
    viewer {
      notifications(first: 10) {
        edges {
          node {
            ... on FollowNotification {
              actors(first: 10) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`);

Deno.test({
  name: "Notification.actors returns actors newest-first",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "notifyme",
        name: "Notify Me",
        email: "notifyme@example.com",
      });
      const olderActor = await insertAccountWithActor(tx, {
        username: "olderactor",
        name: "Older Actor",
        email: "olderactor@example.com",
      });
      const newerActor = await insertAccountWithActor(tx, {
        username: "neweractor",
        name: "Newer Actor",
        email: "neweractor@example.com",
      });

      await tx.insert(notificationTable).values({
        id: crypto.randomUUID(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [olderActor.actor.id, newerActor.actor.id],
        created: new Date("2026-04-15T00:00:00.000Z"),
      });

      const result = await execute({
        schema,
        document: notificationActorsQuery,
        contextValue: makeUserContext(tx, recipient.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const data = result.data as {
        viewer: {
          notifications: {
            edges: {
              node: {
                actors: {
                  edges: { node: { id: string } }[];
                };
              };
            }[];
          };
        } | null;
      };

      const edges = data.viewer?.notifications.edges;
      assert(edges != null && edges.length > 0);
      assertEquals(
        edges[0].node.actors.edges.map((edge) => edge.node.id),
        [
          encodeGlobalID("Actor", newerActor.actor.id),
          encodeGlobalID("Actor", olderActor.actor.id),
        ],
      );
    });
  },
});

import { assertEquals } from "@std/assert/equals";
import { and, eq, or } from "drizzle-orm";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { mute } from "@hackerspub/models/muting";
import { followingTable, mutingTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const muteActorMutation = parse(`
  mutation MuteActor($actorId: ID!) {
    muteActor(input: { actorId: $actorId }) {
      __typename
      ... on MuteActorPayload {
        muter { id }
        mutee { id viewerMutes }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const unmuteActorMutation = parse(`
  mutation UnmuteActor($actorId: ID!) {
    unmuteActor(input: { actorId: $actorId }) {
      __typename
      ... on UnmuteActorPayload {
        muter { id }
        mutee { id viewerMutes }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const mutedActorsQuery = parse(`
  query MutedActors($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      id
      mutedActors {
        edges { node { id } }
      }
    }
  }
`);

Deno.test({
  name:
    "muteActor and unmuteActor round-trip through GraphQL without touching follows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const muter = await insertAccountWithActor(tx, {
        username: "graphqlmuter",
        name: "GraphQL Muter",
        email: "graphqlmuter@example.com",
      });
      const mutee = await insertAccountWithActor(tx, {
        username: "graphqlmutee",
        name: "GraphQL Mutee",
        email: "graphqlmutee@example.com",
      });
      const fedCtx = createFedCtx(tx);
      const actorId = encodeGlobalID("Actor", mutee.actor.id);

      // Mutual follow: muting must leave both follow rows intact.
      await follow(fedCtx, muter.account, mutee.actor);
      await follow(fedCtx, mutee.account, muter.actor);

      const muteResult = await execute({
        schema,
        document: muteActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, muter.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(muteResult.errors, undefined);
      const mutePayload = (muteResult.data as {
        muteActor: {
          __typename: string;
          mutee?: { id: string; viewerMutes: boolean };
        };
      }).muteActor;
      assertEquals(mutePayload.__typename, "MuteActorPayload");
      assertEquals(mutePayload.mutee, { id: actorId, viewerMutes: true });

      const storedMute = await tx.select().from(mutingTable).where(and(
        eq(mutingTable.muterId, muter.actor.id),
        eq(mutingTable.muteeId, mutee.actor.id),
      ));
      assertEquals(storedMute.length, 1);

      // Follows are untouched (unlike blocking).
      const followsAfterMute = await tx.select().from(followingTable).where(or(
        and(
          eq(followingTable.followerId, muter.actor.id),
          eq(followingTable.followeeId, mutee.actor.id),
        ),
        and(
          eq(followingTable.followerId, mutee.actor.id),
          eq(followingTable.followeeId, muter.actor.id),
        ),
      ));
      assertEquals(followsAfterMute.length, 2);

      const unmuteResult = await execute({
        schema,
        document: unmuteActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, muter.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(unmuteResult.errors, undefined);
      const unmutePayload = (unmuteResult.data as {
        unmuteActor: {
          __typename: string;
          mutee?: { id: string; viewerMutes: boolean };
        };
      }).unmuteActor;
      assertEquals(unmutePayload.__typename, "UnmuteActorPayload");
      assertEquals(unmutePayload.mutee, { id: actorId, viewerMutes: false });

      const storedAfterUnmute = await tx.select().from(mutingTable).where(and(
        eq(mutingTable.muterId, muter.actor.id),
        eq(mutingTable.muteeId, mutee.actor.id),
      ));
      assertEquals(storedAfterUnmute, []);
    });
  },
});

Deno.test({
  name: "muteActor rejects muting yourself and unauthenticated requests",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "selfmuter",
        name: "Self Muter",
        email: "selfmuter@example.com",
      });
      const ownId = encodeGlobalID("Actor", account.actor.id);

      const selfResult = await execute({
        schema,
        document: muteActorMutation,
        variableValues: { actorId: ownId },
        contextValue: makeUserContext(tx, account.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(selfResult.errors, undefined);
      assertEquals(
        (selfResult.data as { muteActor: { __typename: string } }).muteActor
          .__typename,
        "InvalidInputError",
      );

      const guestResult = await execute({
        schema,
        document: muteActorMutation,
        variableValues: { actorId: ownId },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guestResult.errors, undefined);
      assertEquals(
        (guestResult.data as { muteActor: { __typename: string } }).muteActor
          .__typename,
        "NotAuthenticatedError",
      );
    });
  },
});

Deno.test({
  name: "Actor.mutedActors is readable only by the owner",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const muter = await insertAccountWithActor(tx, {
        username: "mutedlistowner",
        name: "Muted List Owner",
        email: "mutedlistowner@example.com",
      });
      const mutee = await insertAccountWithActor(tx, {
        username: "mutedlisttarget",
        name: "Muted List Target",
        email: "mutedlisttarget@example.com",
      });
      const other = await insertAccountWithActor(tx, {
        username: "mutedlistsnooper",
        name: "Muted List Snooper",
        email: "mutedlistsnooper@example.com",
      });
      await mute(tx, muter.account, mutee.actor);

      const muteeGlobalId = encodeGlobalID("Actor", mutee.actor.id);

      // The owner sees their muted actor.
      const ownerView = await execute({
        schema,
        document: mutedActorsQuery,
        variableValues: { uuid: muter.actor.id },
        contextValue: makeUserContext(tx, muter.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(ownerView.errors, undefined);
      assertEquals(ownerView.data, {
        actorByUuid: {
          id: encodeGlobalID("Actor", muter.actor.id),
          mutedActors: { edges: [{ node: { id: muteeGlobalId } }] },
        },
      });

      // A different signed-in viewer sees an empty list (mute lists are private).
      const snooperView = await execute({
        schema,
        document: mutedActorsQuery,
        variableValues: { uuid: muter.actor.id },
        contextValue: makeUserContext(tx, other.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(snooperView.errors, undefined);
      assertEquals(snooperView.data, {
        actorByUuid: {
          id: encodeGlobalID("Actor", muter.actor.id),
          mutedActors: { edges: [] },
        },
      });

      // A guest also sees an empty list.
      const guestView = await execute({
        schema,
        document: mutedActorsQuery,
        variableValues: { uuid: muter.actor.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guestView.errors, undefined);
      assertEquals(guestView.data, {
        actorByUuid: {
          id: encodeGlobalID("Actor", muter.actor.id),
          mutedActors: { edges: [] },
        },
      });
    });
  },
});

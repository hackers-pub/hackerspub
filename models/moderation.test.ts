import assert from "node:assert";
import { describe, it } from "node:test";
import type { ApplicationContext } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { follow } from "@hackerspub/models/following";
import {
  ActorSuspendedError,
  assertAccountActorNotSuspended,
  assertActorNotSuspended,
  isActorBanned,
  isActorSuspended,
} from "@hackerspub/models/moderation";
import { createNote } from "@hackerspub/models/note";
import { sharePost } from "@hackerspub/models/post";
import { react } from "@hackerspub/models/reaction";
import { actorTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-04-15T12:00:00.000Z");

function actorState(
  suspended: Date | null,
  suspendedUntil: Date | null,
): { suspended: Date | null; suspendedUntil: Date | null } {
  return { suspended, suspendedUntil };
}

describe("isActorSuspended()", () => {
  it("is false without a sanction", () => {
    assert.equal(isActorSuspended(actorState(null, null), NOW), false);
  });

  it("is true during an active temporary suspension", () => {
    assert.equal(
      isActorSuspended(
        actorState(
          new Date(NOW.getTime() - HOUR),
          new Date(NOW.getTime() + HOUR),
        ),
        NOW,
      ),
      true,
    );
  });

  it("is true for a permanent suspension", () => {
    assert.equal(
      isActorSuspended(actorState(new Date(NOW.getTime() - HOUR), null), NOW),
      true,
    );
  });

  it("is false after expiry and before start", () => {
    assert.equal(
      isActorSuspended(
        actorState(
          new Date(NOW.getTime() - 2 * HOUR),
          new Date(NOW.getTime() - HOUR),
        ),
        NOW,
      ),
      false,
    );
    assert.equal(
      isActorSuspended(
        actorState(
          new Date(NOW.getTime() + HOUR),
          new Date(NOW.getTime() + 2 * HOUR),
        ),
        NOW,
      ),
      false,
    );
  });
});

describe("isActorBanned()", () => {
  it("is true only for active permanent suspensions", () => {
    assert.equal(
      isActorBanned(actorState(new Date(NOW.getTime() - HOUR), null), NOW),
      true,
    );
    assert.equal(
      isActorBanned(
        actorState(
          new Date(NOW.getTime() - HOUR),
          new Date(NOW.getTime() + HOUR),
        ),
        NOW,
      ),
      false,
    );
    assert.equal(isActorBanned(actorState(null, null), NOW), false);
  });
});

describe("assertActorNotSuspended()", () => {
  it("throws ActorSuspendedError for suspended actors", () => {
    const actor = {
      id: "0196fd00-0000-7000-8000-000000000000" as const,
      suspended: new Date(NOW.getTime() - HOUR),
      suspendedUntil: new Date(NOW.getTime() + HOUR),
    };
    assert.throws(
      () => assertActorNotSuspended(actor, NOW),
      ActorSuspendedError,
    );
    assert.doesNotThrow(() =>
      assertActorNotSuspended({ ...actor, suspended: null }, NOW),
    );
  });
});

describe("write-path suspension guards", () => {
  async function suspend(tx: Transaction, actorId: string): Promise<void> {
    await tx
      .update(actorTable)
      .set({ suspended: new Date(Date.now() - HOUR) })
      .where(eq(actorTable.id, actorId as never));
  }

  it("blocks createNote for suspended authors", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "suspendedauthor",
        name: "Suspended",
        email: "suspendedauthor@example.com",
      });
      await suspend(tx, author.actor.id);
      await assert.rejects(
        createNote(fedCtx as unknown as ApplicationContext<Transaction>, {
          accountId: author.account.id,
          visibility: "public",
          content: "Hello",
          language: "en",
          media: [],
        }),
        ActorSuspendedError,
      );
    });
  });

  it("allows createNote after the suspension expires", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "expiredauthor",
        name: "Expired",
        email: "expiredauthor@example.com",
      });
      await tx
        .update(actorTable)
        .set({
          suspended: new Date(Date.now() - 2 * HOUR),
          suspendedUntil: new Date(Date.now() - HOUR),
        })
        .where(eq(actorTable.id, author.actor.id));
      const note = await createNote(
        fedCtx as unknown as ApplicationContext<Transaction>,
        {
          accountId: author.account.id,
          visibility: "public",
          content: "Hello again",
          language: "en",
          media: [],
        },
      );
      assert.ok(note != null);
    });
  });

  it("blocks reactions from suspended actors", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const reactor = await insertAccountWithActor(tx, {
        username: "suspendedreactor",
        name: "Reactor",
        email: "suspendedreactor@example.com",
      });
      const author = await insertAccountWithActor(tx, {
        username: "postauthor",
        name: "Author",
        email: "postauthor@example.com",
      });
      const { post } = await insertNotePost(tx, { account: author.account });
      await suspend(tx, reactor.actor.id);
      const suspendedReactor = await tx.query.actorTable.findFirst({
        where: { id: reactor.actor.id },
      });
      assert.ok(suspendedReactor != null);
      await assert.rejects(
        react(
          fedCtx,
          { ...reactor.account, actor: suspendedReactor },
          { ...post, actor: author.actor },
          "❤️",
        ),
        ActorSuspendedError,
      );
    });
  });

  it("blocks follows from suspended actors", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const follower = await insertAccountWithActor(tx, {
        username: "suspendedfollower",
        name: "Follower",
        email: "suspendedfollower@example.com",
      });
      const followee = await insertAccountWithActor(tx, {
        username: "followee",
        name: "Followee",
        email: "followee@example.com",
      });
      await suspend(tx, follower.actor.id);
      const suspendedFollower = await tx.query.actorTable.findFirst({
        where: { id: follower.actor.id },
      });
      assert.ok(suspendedFollower != null);
      await assert.rejects(
        follow(
          fedCtx,
          { ...follower.account, actor: suspendedFollower },
          followee.actor,
        ),
        ActorSuspendedError,
      );
    });
  });

  it("blocks boosts from suspended actors", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const booster = await insertAccountWithActor(tx, {
        username: "suspendedbooster",
        name: "Booster",
        email: "suspendedbooster@example.com",
      });
      const author = await insertAccountWithActor(tx, {
        username: "boostedauthor",
        name: "Author",
        email: "boostedauthor@example.com",
      });
      const { post } = await insertNotePost(tx, { account: author.account });
      await suspend(tx, booster.actor.id);
      await assert.rejects(
        sharePost(fedCtx, booster.account, { ...post, actor: author.actor }),
        ActorSuspendedError,
      );
    });
  });

  it("assertAccountActorNotSuspended checks by account id", async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "checked",
        name: "Checked",
        email: "checked@example.com",
      });
      await assertAccountActorNotSuspended(tx, account.account.id);
      await suspend(tx, account.actor.id);
      await assert.rejects(
        assertAccountActorNotSuspended(tx, account.account.id),
        ActorSuspendedError,
      );
    });
  });
});

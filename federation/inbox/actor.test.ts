import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import {
  actorTable,
  flagCaseTable,
  flagTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertRemoteActor,
  withRollback,
} from "../../test/postgres.ts";
import { onActorDeleted } from "./actor.ts";

function inboxCtx(tx: Transaction): InboxContext<ContextData> {
  return createFedCtx(tx) as unknown as InboxContext<ContextData>;
}

function selfDelete(iri: string, id: string): Delete {
  return new Delete({
    id: new URL(id),
    actor: new URL(iri),
    object: new URL(iri),
  });
}

describe("onActorDeleted()", () => {
  it("keeps a sanctioned actor and its case on self-delete", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const actor = await insertRemoteActor(tx, {
        username: "bannedremote",
        name: "Banned Remote",
        host: "remote.example",
      });
      // Federation-block (ban) the actor and open a case against it.
      await tx
        .update(actorTable)
        .set({ suspended: new Date(Date.now() - 1000), suspendedUntil: null })
        .where(eq(actorTable.id, actor.id));
      const caseId = generateUuidV7();
      await tx.insert(flagCaseTable).values({
        id: caseId,
        targetActorId: actor.id,
      });

      const handled = await onActorDeleted(
        fedCtx,
        selfDelete(actor.iri, "https://remote.example/delete/1"),
      );
      // The Delete is recognized but deliberately not acted on, so the actor
      // row (its suspension) and the case audit survive: the IRI cannot
      // re-federate without the federation block.
      assert.equal(handled, true);
      const stillThere = await tx.query.actorTable.findFirst({
        where: { id: actor.id },
      });
      assert.ok(stillThere != null);
      assert.ok(stillThere.suspended != null);
      const flagCase = await tx.query.flagCaseTable.findFirst({
        where: { id: caseId },
      });
      assert.ok(flagCase != null);
    });
  });

  it("keeps an actor with a moderation case but no active suspension", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const actor = await insertRemoteActor(tx, {
        username: "warnedremote",
        name: "Warned Remote",
        host: "remote.example",
      });
      // A standing warning/censor action, or an expired temporary suspension,
      // leaves a case audit but no active suspension.
      const caseId = generateUuidV7();
      await tx.insert(flagCaseTable).values({
        id: caseId,
        targetActorId: actor.id,
      });

      const handled = await onActorDeleted(
        fedCtx,
        selfDelete(actor.iri, "https://remote.example/delete/3"),
      );
      // The actor row and its case audit must survive: deleting the actor
      // would cascade-erase the immutable case/action audit and let the IRI
      // re-federate without its history.
      assert.equal(handled, true);
      const stillThere = await tx.query.actorTable.findFirst({
        where: { id: actor.id },
      });
      assert.ok(stillThere != null);
      const flagCase = await tx.query.flagCaseTable.findFirst({
        where: { id: caseId },
      });
      assert.ok(flagCase != null);
    });
  });

  it("keeps an actor that reported a flag on self-delete", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const reporter = await insertRemoteActor(tx, {
        username: "reporterremote",
        name: "Reporter Remote",
        host: "remote.example",
      });
      const target = await insertRemoteActor(tx, {
        username: "reportedremote",
        name: "Reported Remote",
        host: "remote.example",
      });
      // The reporter is not itself a case target, but it filed a flag; the
      // flag (and its content_snapshot) cascade off reporter_id, so deleting
      // the reporter would erase pending moderation evidence.
      const caseId = generateUuidV7();
      await tx.insert(flagCaseTable).values({
        id: caseId,
        targetActorId: target.id,
      });
      const flagId = generateUuidV7();
      await tx.insert(flagTable).values({
        id: flagId,
        reporterId: reporter.id,
        targetActorId: target.id,
        reason: "Reported content",
        caseId,
      });

      const handled = await onActorDeleted(
        fedCtx,
        selfDelete(reporter.iri, "https://remote.example/delete/4"),
      );
      assert.equal(handled, true);
      const stillThere = await tx.query.actorTable.findFirst({
        where: { id: reporter.id },
      });
      assert.ok(stillThere != null);
      const flag = await tx.query.flagTable.findFirst({
        where: { id: flagId },
      });
      assert.ok(flag != null);
    });
  });

  it("deletes an unsanctioned actor on self-delete", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const actor = await insertRemoteActor(tx, {
        username: "plainremote",
        name: "Plain Remote",
        host: "remote.example",
      });
      const handled = await onActorDeleted(
        fedCtx,
        selfDelete(actor.iri, "https://remote.example/delete/2"),
      );
      assert.equal(handled, true);
      const gone = await tx.query.actorTable.findFirst({
        where: { id: actor.id },
      });
      assert.equal(gone, undefined);
    });
  });
});

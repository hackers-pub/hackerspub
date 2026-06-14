import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { actorTable, flagCaseTable } from "@hackerspub/models/schema";
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
      await tx.update(actorTable)
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

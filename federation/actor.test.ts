import assert from "node:assert";
import test from "node:test";
import { Organization, Person } from "@fedify/vocab";
import { actorTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { getAccountActor } from "./person.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

test("getAccountActor serves a suspended stub for banned accounts", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "apbanned",
      name: "AP Banned",
      email: "apbanned@example.com",
    });
    const fedCtx = createFedCtx(tx);

    // An unsanctioned account gets the full profile and no flag:
    const normal = await getAccountActor(fedCtx, account, []);
    assert.equal(normal.suspended, null);
    assert.equal(normal.name?.toString(), "AP Banned");
    assert.ok(normal.summary != null);
    assert.ok(await normal.getIcon() != null);

    // A permanently suspended (banned) account gets a stub: the document
    // stays fetchable, but the profile content is emptied and Mastodon's
    // `suspended` flag is set.
    await tx.update(actorTable)
      .set({ suspended: new Date(Date.now() - 1000), suspendedUntil: null })
      .where(eq(actorTable.accountId, account.id));
    const refreshed = await tx.query.accountTable.findFirst({
      where: { id: account.id },
      with: {
        actor: true,
        avatarMedium: true,
        emails: true,
        links: { orderBy: { index: "asc" } },
      },
    });
    assert.ok(refreshed != null);
    const stub = await getAccountActor(fedCtx, refreshed, []);
    assert.equal(stub.suspended, true);
    assert.equal(stub.preferredUsername?.toString(), "apbanned");
    assert.equal(stub.name, null);
    assert.equal(stub.summary, null);
    assert.equal(await stub.getIcon(), null);
    assert.equal(stub.attachmentIds.length, 0);
    // Identity and endpoints survive so signatures keep verifying and the
    // suspension is not mistaken for a deletion:
    assert.ok(stub.id != null);
    assert.ok(stub.inboxId != null);

    // A *temporary* suspension only restricts writing; the profile stays:
    await tx.update(actorTable)
      .set({
        suspended: new Date(Date.now() - 1000),
        suspendedUntil: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(actorTable.accountId, account.id));
    const temp = await tx.query.accountTable.findFirst({
      where: { id: account.id },
      with: {
        actor: true,
        avatarMedium: true,
        emails: true,
        links: { orderBy: { index: "asc" } },
      },
    });
    assert.ok(temp != null);
    const tempActor = await getAccountActor(fedCtx, temp, []);
    assert.equal(tempActor.suspended, null);
    assert.equal(tempActor.name?.toString(), "AP Banned");
  });
});

test("getAccountActor exposes account migration aliases", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "apaliases",
      name: "AP Aliases",
      email: "apaliases@example.com",
    });
    await tx.update(actorTable)
      .set({
        aliases: [
          "https://old.example/users/apaliases",
          "https://older.example/users/apaliases",
        ],
      })
      .where(eq(actorTable.accountId, account.id));
    const refreshed = await tx.query.accountTable.findFirst({
      where: { id: account.id },
      with: {
        actor: true,
        avatarMedium: true,
        emails: true,
        links: { orderBy: { index: "asc" } },
      },
    });
    assert.ok(refreshed != null);

    const actor = await getAccountActor(createFedCtx(tx), refreshed, []);

    assert.deepEqual(actor.aliasIds.map((alias) => alias.href), [
      "https://old.example/users/apaliases",
      "https://older.example/users/apaliases",
    ]);
  });
});

test("getAccountActor uses Organization for organization accounts", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "aporganization",
      name: "AP Organization",
      email: "aporganization@example.com",
      kind: "organization",
      type: "Organization",
    });

    const actor = await getAccountActor(createFedCtx(tx), account, []);

    assert.ok(actor instanceof Organization);
    assert.ok(!(actor instanceof Person));
    assert.equal(actor.preferredUsername?.toString(), "aporganization");
    assert.equal(actor.name?.toString(), "AP Organization");
  });
});

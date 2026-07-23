import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import { Flag } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { actorTable, postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../../test/postgres.ts";
import { onFlagged } from "./flag.ts";

function inboxCtx(tx: Transaction): InboxContext<ContextData> {
  return createFedCtx(tx) as unknown as InboxContext<ContextData>;
}

describe("onFlagged()", () => {
  it("files a report for a flagged local post", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const remoteModerator = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderation team",
        host: "remote.example",
        iri: "https://remote.example/actor",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: reported.account,
      });
      const activity = new Flag({
        id: new URL("https://remote.example/flags/1"),
        actor: new URL(remoteModerator.iri),
        objects: [new URL(reported.actor.iri), new URL(post.iri)],
        content: "Violation of our community guidelines",
      });
      await onFlagged(fedCtx, activity);
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/1" },
        with: { snapshot: true },
      });
      assert.ok(flag != null);
      assert.equal(flag.reporterId, remoteModerator.id);
      assert.equal(flag.targetActorId, reported.actor.id);
      assert.equal(flag.targetPostId, post.id);
      assert.equal(flag.reason, "Violation of our community guidelines");
      assert.equal(flag.forwardToRemote, false);
      assert.ok(flag.snapshot != null);

      // Redelivery is deduplicated by the activity IRI:
      await onFlagged(fedCtx, activity);
      const flags = await tx.query.flagTable.findMany({
        where: { iri: "https://remote.example/flags/1" },
      });
      assert.equal(flags.length, 1);
    });
  });

  it("files a user report for a flagged local actor", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const remoteModerator = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderation team",
        host: "remote.example",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const activity = new Flag({
        id: new URL("https://remote.example/flags/2"),
        actor: new URL(remoteModerator.iri),
        objects: [new URL(reported.actor.iri)],
        content: "spam",
      });
      await onFlagged(fedCtx, activity);
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/2" },
      });
      assert.ok(flag != null);
      assert.equal(flag.targetActorId, reported.actor.id);
      assert.equal(flag.targetPostId, null);
      // Short external reasons are accepted:
      assert.equal(flag.reason, "spam");
    });
  });

  it("drops flags whose target is not local", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const remoteModerator = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderation team",
        host: "remote.example",
      });
      const remoteTarget = await insertRemoteActor(tx, {
        username: "troll",
        name: "Troll",
        host: "elsewhere.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteTarget.id,
      });
      const activity = new Flag({
        id: new URL("https://remote.example/flags/3"),
        actor: new URL(remoteModerator.iri),
        objects: [new URL(remoteTarget.iri), new URL(remotePost.iri)],
        content: "Not our user.",
      });
      await onFlagged(fedCtx, activity);
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/3" },
      });
      assert.equal(flag, undefined);
    });
  });

  it("drops flags from cached federation-blocked actors", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const blocked = await insertRemoteActor(tx, {
        username: "blocked",
        name: "Blocked",
        host: "remote.example",
        iri: "https://remote.example/users/blocked",
      });
      await tx.update(actorTable)
        .set({ suspended: new Date() })
        .where(eq(actorTable.id, blocked.id));
      const reported = await insertAccountWithActor(tx, {
        username: "reportedblocked",
        name: "Reported Blocked",
        email: "reportedblocked@example.com",
      });
      await onFlagged(
        fedCtx,
        new Flag({
          id: new URL("https://remote.example/flags/blocked-1"),
          actor: new URL(blocked.iri),
          objects: [new URL(reported.actor.iri)],
          content: "Report from a blocked actor.",
        }),
      );
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/blocked-1" },
      });
      assert.equal(flag, undefined);
    });
  });

  it("does not attach a remote post's URL to a local boost wrapper", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const remoteModerator = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderation team",
        host: "remote.example",
      });
      const remoteTarget = await insertRemoteActor(tx, {
        username: "troll",
        name: "Troll",
        host: "elsewhere.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteTarget.id,
      });
      // The remote post row itself carries no `url` (common for posts
      // whose IRI doubles as the URL); the wrapper denormalizes the
      // public URL, so only the wrapper row matches it.
      const remoteUrl = "https://elsewhere.example/@troll/123";
      // A local user boosted the remote post; the wrapper copies its URL.
      const booster = await insertAccountWithActor(tx, {
        username: "booster",
        name: "Booster",
        email: "booster@example.com",
      });
      const wrapperId = generateUuidV7();
      await tx.insert(postTable).values({
        id: wrapperId,
        iri: `http://localhost/ap/announces/${wrapperId}`,
        type: remotePost.type,
        visibility: "public",
        actorId: booster.actor.id,
        sharedPostId: remotePost.id,
        contentHtml: remotePost.contentHtml,
        tags: {},
        emojis: {},
        url: remoteUrl,
      });
      // The report cites the remote post's URL: its target is not local,
      // so it must be dropped, not attributed to the local booster.
      const activity = new Flag({
        id: new URL("https://remote.example/flags/9"),
        actor: new URL(remoteModerator.iri),
        objects: [new URL(remoteUrl)],
        content: "Reported via its public URL.",
      });
      await onFlagged(fedCtx, activity);
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/9" },
      });
      assert.equal(flag, undefined);
    });
  });

  it("drops flags with no recognizable object", async () => {
    await withRollback(async (tx) => {
      const fedCtx = inboxCtx(tx);
      const remoteModerator = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderation team",
        host: "remote.example",
      });
      const activity = new Flag({
        id: new URL("https://remote.example/flags/4"),
        actor: new URL(remoteModerator.iri),
        objects: [new URL("https://unknown.example/objects/1")],
        content: "???",
      });
      await onFlagged(fedCtx, activity);
      const flag = await tx.query.flagTable.findFirst({
        where: { iri: "https://remote.example/flags/4" },
      });
      assert.equal(flag, undefined);
    });
  });
});

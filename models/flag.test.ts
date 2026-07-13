import assert from "node:assert";
import { describe, it } from "node:test";
import {
  accountTable,
  articleContentTable,
  articleSourceTable,
  flagCaseTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq, sql } from "drizzle-orm";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";
import type { Transaction } from "./db.ts";
import { defineApplicationModel } from "./context.ts";
import {
  analyzeFlag,
  createFlag,
  getFlagByIri,
  MIN_REPORT_REASON_LENGTH,
} from "./flag.ts";

const REASON = "This post contains harassment targeting another user.";

async function createAnalyzableFlag(tx: Transaction) {
  const reporter = await insertAccountWithActor(tx, {
    username: "analysisreporter",
    name: "Analysis Reporter",
    email: "analysisreporter@example.com",
  });
  const reported = await insertAccountWithActor(tx, {
    username: "analysisreported",
    name: "Analysis Reported",
    email: "analysisreported@example.com",
  });
  const { post } = await insertNotePost(tx, {
    account: reported.account,
    content: "Reported content for analysis",
  });
  const flag = await createFlag(tx, {
    reporter: reporter.actor,
    targetActor: reported.actor,
    targetPost: post,
    reason: REASON,
  });
  assert.ok(flag != null);
  return flag;
}

describe("createFlag()", () => {
  it("creates a case, flag, and snapshot for a post report", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: reported.account,
        content: "Offensive content",
      });
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(flag != null);
      assert.equal(flag.reporterId, reporter.actor.id);
      assert.equal(flag.targetActorId, reported.actor.id);
      assert.equal(flag.targetPostId, post.id);
      assert.equal(flag.targetPostIri, post.iri);
      assert.equal(flag.reason, REASON);
      assert.equal(flag.status, "pending");
      assert.equal(flag.forwardToRemote, false);
      assert.equal(flag.iri, null);
      assert.equal(flag.case.targetActorId, reported.actor.id);
      assert.equal(flag.case.targetPostIri, post.iri);
      assert.equal(flag.case.status, "pending");
      assert.equal(flag.snapshot.postId, post.id);
      assert.equal(flag.snapshot.postIri, post.iri);
      assert.equal(flag.snapshot.contentHtml, post.contentHtml);
      assert.equal(flag.snapshot.sourceContent, "Offensive content");
      assert.equal(flag.snapshot.metadata?.postType, "Note");
      assert.equal(
        flag.snapshot.metadata?.actorHandle,
        reported.actor.handle,
      );
    });
  });

  it("joins an existing open case for the same target", async () => {
    await withRollback(async (tx) => {
      const reporterA = await insertAccountWithActor(tx, {
        username: "reportera",
        name: "Reporter A",
        email: "reportera@example.com",
      });
      const reporterB = await insertAccountWithActor(tx, {
        username: "reporterb",
        name: "Reporter B",
        email: "reporterb@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const first = await createFlag(tx, {
        reporter: reporterA.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      const second = await createFlag(tx, {
        reporter: reporterB.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: "Another independent report about the same post.",
      });
      assert.ok(first != null && second != null);
      assert.equal(first.caseId, second.caseId);
      assert.notEqual(first.id, second.id);
    });
  });

  it("starts a report joining a reviewing case as reviewing", async () => {
    await withRollback(async (tx) => {
      const reporterA = await insertAccountWithActor(tx, {
        username: "reportera",
        name: "Reporter A",
        email: "reportera@example.com",
      });
      const reporterB = await insertAccountWithActor(tx, {
        username: "reporterb",
        name: "Reporter B",
        email: "reporterb@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const first = await createFlag(tx, {
        reporter: reporterA.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(first != null);
      assert.equal(first.status, "pending");
      // The case is taken under review before the second report arrives.
      await tx.update(flagCaseTable)
        .set({ status: "reviewing" })
        .where(eq(flagCaseTable.id, first.caseId));
      const second = await createFlag(tx, {
        reporter: reporterB.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: "Another independent report about the same post.",
      });
      assert.ok(second != null);
      assert.equal(second.caseId, first.caseId);
      // A report joining a case already under review inherits its status
      // instead of starting at the `pending` column default.
      assert.equal(second.status, "reviewing");
    });
  });

  it("opens a new case when the previous one is closed", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const first = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(first != null);
      await tx.update(flagCaseTable)
        .set({ status: "dismissed", resolved: sql`CURRENT_TIMESTAMP` })
        .where(eq(flagCaseTable.id, first.caseId));
      const second = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: "Reporting the same post again after dismissal.",
      });
      assert.ok(second != null);
      assert.notEqual(second.caseId, first.caseId);
    });
  });

  it("rejects a duplicate open report from the same reporter", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const first = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(first != null);
      const second = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: "Trying to report the same post a second time.",
      });
      assert.equal(second, undefined);
    });
  });

  it("deduplicates incoming Flag activities by IRI", async () => {
    await withRollback(async (tx) => {
      const remoteReporter = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderator",
        host: "remote.example",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const iri = "https://remote.example/flags/1";
      const first = await createFlag(tx, {
        reporter: remoteReporter,
        targetActor: reported.actor,
        targetPost: post,
        reason: "spam",
        iri,
      });
      assert.ok(first != null);
      assert.equal(first.iri, iri);
      const redelivered = await createFlag(tx, {
        reporter: remoteReporter,
        targetActor: reported.actor,
        targetPost: post,
        reason: "spam",
        iri,
      });
      assert.equal(redelivered, undefined);
      assert.ok(await getFlagByIri(tx, iri) != null);
      assert.equal(
        await getFlagByIri(tx, "https://remote.example/flags/2"),
        undefined,
      );
    });
  });

  it("allows short reasons for external reports but not local ones", async () => {
    await withRollback(async (tx) => {
      const localReporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const remoteReporter = await insertRemoteActor(tx, {
        username: "remotemod",
        name: "Remote moderator",
        host: "remote.example",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const shortReason = "spam";
      assert.ok(shortReason.length < MIN_REPORT_REASON_LENGTH);
      const local = await createFlag(tx, {
        reporter: localReporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: shortReason,
      });
      assert.equal(local, undefined);
      const external = await createFlag(tx, {
        reporter: remoteReporter,
        targetActor: reported.actor,
        targetPost: post,
        reason: shortReason,
        iri: "https://remote.example/flags/1",
      });
      assert.ok(external != null);
    });
  });

  it("snapshots the profile for a user report", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertRemoteActor(tx, {
        username: "troll",
        name: "Troll",
        host: "remote.example",
      });
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported,
        reason: "This user's profile is full of hate speech.",
        forwardToRemote: true,
      });
      assert.ok(flag != null);
      assert.equal(flag.targetPostId, null);
      assert.equal(flag.targetPostIri, null);
      assert.equal(flag.forwardToRemote, true);
      assert.equal(flag.case.targetPostIri, null);
      assert.equal(flag.snapshot.postId, null);
      assert.equal(flag.snapshot.contentHtml, reported.bioHtml ?? "");
      assert.equal(flag.snapshot.sourceContent, null);
      assert.equal(flag.snapshot.metadata?.actorHandle, reported.handle);
    });
  });

  it("snapshots the original article content for article reports", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const articleSourceId = generateUuidV7();
      await tx.insert(articleSourceTable).values({
        id: articleSourceId,
        accountId: reported.account.id,
        publishedYear: 2026,
        slug: "offensive-article",
        published: new Date("2026-04-15T00:00:00.000Z"),
        updated: new Date("2026-04-15T00:00:00.000Z"),
      });
      await tx.insert(articleContentTable).values({
        sourceId: articleSourceId,
        language: "en",
        title: "Offensive article",
        content: "Original article markdown",
        published: new Date("2026-04-15T00:00:00.000Z"),
        updated: new Date("2026-04-15T00:00:00.000Z"),
      });
      const postId = generateUuidV7();
      await tx.insert(postTable).values({
        id: postId,
        iri: `http://localhost/articles/${postId}`,
        type: "Article",
        visibility: "public",
        actorId: reported.actor.id,
        articleSourceId,
        name: "Offensive article",
        contentHtml: "<p>Offensive article body</p>",
        language: "en",
      });
      const post = await tx.query.postTable.findFirst({
        where: { id: postId },
      });
      assert.ok(post != null);
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(flag != null);
      assert.equal(flag.snapshot.sourceContent, "Original article markdown");
      assert.equal(flag.snapshot.metadata?.postType, "Article");
      assert.equal(flag.snapshot.metadata?.name, "Offensive article");
    });
  });

  it("keeps the snapshot for remote posts without source content", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const remote = await insertRemoteActor(tx, {
        username: "troll",
        name: "Troll",
        host: "remote.example",
      });
      const post = await insertRemotePost(tx, {
        actorId: remote.id,
        contentHtml: "<p>Remote offensive post</p>",
      });
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: remote,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(flag != null);
      assert.equal(flag.snapshot.contentHtml, "<p>Remote offensive post</p>");
      assert.equal(flag.snapshot.sourceContent, null);
    });
  });

  it("rejects self-reports", async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "selfreporter",
        name: "Self reporter",
        email: "self@example.com",
      });
      const { post } = await insertNotePost(tx, { account: account.account });
      const flag = await createFlag(tx, {
        reporter: account.actor,
        targetActor: account.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.equal(flag, undefined);
    });
  });

  it("rejects a post that does not belong to the target actor", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const bystander = await insertAccountWithActor(tx, {
        username: "bystander",
        name: "Bystander",
        email: "bystander@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: bystander.account,
      });
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.equal(flag, undefined);
    });
  });

  it("records the code of conduct version", async () => {
    await withRollback(async (tx) => {
      const reporter = await insertAccountWithActor(tx, {
        username: "reporter",
        name: "Reporter",
        email: "reporter@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(flag != null);
      if (flag.cocVersion != null) {
        assert.match(flag.cocVersion, /^[0-9a-f]{40}$/);
      }
    });
  });

  it("notifies moderators once per open case", async () => {
    await withRollback(async (tx) => {
      // Isolate from any moderator accounts already present in the
      // database; the update is rolled back with the transaction.
      await tx.update(accountTable).set({ moderator: false });
      const moderator = await insertAccountWithActor(tx, {
        username: "moderator",
        name: "Moderator",
        email: "moderator@example.com",
      });
      await tx.update(accountTable)
        .set({ moderator: true })
        .where(eq(accountTable.id, moderator.account.id));
      const reporterA = await insertAccountWithActor(tx, {
        username: "reportera",
        name: "Reporter A",
        email: "reportera@example.com",
      });
      const reporterB = await insertAccountWithActor(tx, {
        username: "reporterb",
        name: "Reporter B",
        email: "reporterb@example.com",
      });
      const reported = await insertAccountWithActor(tx, {
        username: "reported",
        name: "Reported",
        email: "reported@example.com",
      });
      const { post } = await insertNotePost(tx, { account: reported.account });
      const first = await createFlag(tx, {
        reporter: reporterA.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: REASON,
      });
      assert.ok(first != null);
      const notifications = await tx.query.moderationNotificationTable
        .findMany({ where: { type: "flag_received", caseId: first.caseId } });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].accountId, moderator.account.id);
      // A second report on the same open case does not duplicate the
      // unread notification.
      const second = await createFlag(tx, {
        reporter: reporterB.actor,
        targetActor: reported.actor,
        targetPost: post,
        reason: "Another independent report about the same post.",
      });
      assert.ok(second != null);
      const afterSecond = await tx.query.moderationNotificationTable
        .findMany({ where: { type: "flag_received", caseId: first.caseId } });
      assert.equal(afterSecond.length, 1);
      // Reporters and the reported user get nothing.
      assert.ok(
        afterSecond.every((n) => n.accountId === moderator.account.id),
      );
    });
  });
});

describe("analyzeFlag()", () => {
  it("uses the injected analyzer and stores its result", async () => {
    await withRollback(async (tx) => {
      const flag = await createAnalyzableFlag(tx);
      let analyzedReason: string | undefined;
      await analyzeFlag(
        tx,
        {
          analyzeFlaggedContent(options) {
            analyzedReason = options.reason;
            assert.equal(options.contentHtml, flag.snapshot.contentHtml);
            assert.ok(options.provisions.length > 0);
            return Promise.resolve({
              matches: [{
                provision: options.provisions[0].id,
                confidence: 0.75,
                rationale: "The report matches this provision.",
              }],
              summary: "A concise moderation summary.",
            });
          },
        },
        defineApplicationModel({}, "test-analyzer"),
        flag,
        flag.snapshot,
      );

      assert.equal(analyzedReason, REASON);
      const stored = await tx.query.flagTable.findFirst({
        where: { id: flag.id },
      });
      assert.equal(stored?.llmAnalysis?.model, "test-analyzer");
      assert.equal(
        stored?.llmAnalysis?.summary,
        "A concise moderation summary.",
      );
      assert.equal(stored?.llmAnalysis?.matches.length, 1);
      assert.equal(stored?.llmAnalysis?.error, undefined);
    });
  });

  it("stores analyzer failures without rejecting", async () => {
    await withRollback(async (tx) => {
      const flag = await createAnalyzableFlag(tx);
      await analyzeFlag(
        tx,
        {
          analyzeFlaggedContent() {
            return Promise.reject(new Error("analyzer unavailable"));
          },
        },
        defineApplicationModel({}, "failing-analyzer"),
        flag,
        flag.snapshot,
      );

      const stored = await tx.query.flagTable.findFirst({
        where: { id: flag.id },
      });
      assert.equal(stored?.llmAnalysis?.model, "failing-analyzer");
      assert.deepEqual(stored?.llmAnalysis?.matches, []);
      assert.equal(stored?.llmAnalysis?.summary, "");
      assert.match(
        stored?.llmAnalysis?.error ?? "",
        /analyzer unavailable/,
      );
    });
  });
});

import assert from "node:assert";
import test from "node:test";
import { Delete, Organization, Tombstone } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import {
  AccountDeletionUnavailableError,
  deleteAccount,
  isUsernameReserved,
  updateAccountData,
} from "./account.ts";
import { NEWS_W_SHARE, recomputeNewsScores } from "./news.ts";
import { createFollowNotification } from "./notification.ts";
import { react } from "./reaction.ts";
import {
  accountKeyTable,
  accountTable,
  actorTable,
  articleContentTable,
  articleSourceTable,
  deletedAccountTable,
  flagCaseTable,
  followingTable,
  instanceTable,
  notificationTable,
  pollOptionTable,
  pollTable,
  pollVoteTable,
  postTable,
  timelineItemTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  withRollback,
} from "../test/postgres.ts";

function assertAlmostEquals(
  actual: number,
  expected: number,
  delta: number,
): void {
  assert.ok(
    Math.abs(actual - expected) <= delta,
    `Expected ${actual} to be within ${delta} of ${expected}`,
  );
}

test("deleteAccount() hard-deletes an account and reserves the current username", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const sentActivities: unknown[][] = [];

    const survivor = await insertAccountWithActor(tx, {
      username: "deleteparent",
      name: "Delete Parent",
      email: "deleteparent@example.com",
    });
    const timelineViewer = await insertAccountWithActor(tx, {
      username: "deleteviewer",
      name: "Delete Viewer",
      email: "deleteviewer@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletecurrent",
      name: "Delete Current",
      email: "deletecurrent@example.com",
    });
    const followerId = generateUuidV7();
    await tx.insert(instanceTable).values({ host: "deletefollower.example" });
    await tx.insert(actorTable).values({
      id: followerId,
      iri: "https://deletefollower.example/users/alice",
      type: "Person",
      username: "alice",
      instanceHost: "deletefollower.example",
      handleHost: "deletefollower.example",
      inboxUrl: "https://deletefollower.example/users/alice/inbox",
      sharedInboxUrl: "https://deletefollower.example/inbox",
    });
    await tx.insert(followingTable).values({
      iri: "https://deletefollower.example/follows/alice-deletecurrent",
      followerId,
      followeeId: target.actor.id,
      accepted: new Date("2026-04-10T00:00:00.000Z"),
    });
    const followeeId = generateUuidV7();
    await tx.insert(instanceTable).values({ host: "deletefollowee.example" });
    await tx.insert(actorTable).values({
      id: followeeId,
      iri: "https://deletefollowee.example/users/bob",
      type: "Person",
      username: "bob",
      instanceHost: "deletefollowee.example",
      handleHost: "deletefollowee.example",
      inboxUrl: "https://deletefollowee.example/users/bob/inbox",
      sharedInboxUrl: "https://deletefollowee.example/inbox",
    });
    await tx.insert(followingTable).values({
      iri: "http://localhost/follows/deletecurrent-bob",
      followerId: target.actor.id,
      followeeId,
      accepted: new Date("2026-04-11T00:00:00.000Z"),
    });
    const pendingFolloweeId = generateUuidV7();
    await tx.insert(instanceTable).values({
      host: "deletepending.example",
    });
    await tx.insert(actorTable).values({
      id: pendingFolloweeId,
      iri: "https://deletepending.example/users/charlie",
      type: "Person",
      username: "charlie",
      instanceHost: "deletepending.example",
      handleHost: "deletepending.example",
      inboxUrl: "https://deletepending.example/users/charlie/inbox",
      sharedInboxUrl: "https://deletepending.example/inbox",
    });
    await tx.insert(followingTable).values({
      iri: "http://localhost/follows/deletecurrent-charlie",
      followerId: target.actor.id,
      followeeId: pendingFolloweeId,
      accepted: null,
    });
    const renamed = await updateAccountData(tx, {
      id: target.account.id,
      username: "deleterenamed",
    });
    assert.ok(renamed != null);

    const { post: parentPost } = await insertNotePost(tx, {
      account: survivor.account,
      content: "Parent post",
    });
    const { post: replyPost } = await insertNotePost(tx, {
      account: target.account,
      content: "Reply",
      replyTargetId: parentPost.id,
    });
    const { post: sharePost } = await insertNotePost(tx, {
      account: target.account,
      content: "Share",
      sharedPostId: parentPost.id,
    });
    const { post: quotePost } = await insertNotePost(tx, {
      account: target.account,
      content: "Quote",
      quotedPostId: parentPost.id,
    });
    await tx.insert(accountKeyTable).values({
      accountId: target.account.id,
      type: "RSASSA-PKCS1-v1_5",
      public: { kty: "test-public" },
      private: { kty: "test-private" },
    });
    await tx.update(postTable)
      .set({ repliesCount: 1, sharesCount: 1, quotesCount: 1 })
      .where(eq(postTable.id, parentPost.id));
    await tx.insert(timelineItemTable).values({
      accountId: timelineViewer.account.id,
      postId: parentPost.id,
      postType: parentPost.type,
      originalAuthorId: null,
      lastSharerId: target.actor.id,
      sharersCount: 1,
      added: new Date("2026-04-12T00:00:00.000Z"),
      appended: new Date("2026-04-12T00:00:00.000Z"),
    });

    let sendObservedState:
      | {
        accountExists: boolean;
        tombstoneUsername: string | undefined;
        preservedKeyTypes: string[];
      }
      | undefined;
    fedCtx.sendActivity = (async (...args: unknown[]) => {
      sentActivities.push(args);
      const account = await tx.query.accountTable.findFirst({
        where: { id: target.account.id },
        columns: { id: true },
      });
      const tombstone = await tx.query.deletedAccountTable.findFirst({
        where: { accountId: target.account.id },
      });
      const preservedKeys = await tx.query.deletedAccountKeyTable.findMany({
        where: { accountId: target.account.id },
        columns: { type: true },
        orderBy: { type: "asc" },
      });
      sendObservedState = {
        accountExists: account != null,
        tombstoneUsername: tombstone?.username,
        preservedKeyTypes: preservedKeys.map((key) => key.type),
      };
    }) as typeof fedCtx.sendActivity;

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.ok(result != null);
    assert.equal(result.accountId, target.account.id);
    assert.equal(result.username, "deleterenamed");
    assert.ok(result.deleted instanceof Date);

    assert.equal(sentActivities.length, 1);
    assert.ok(Array.isArray(sentActivities[0][1]));
    assert.deepEqual(
      sentActivities[0][1].map((recipient) => ({
        id: recipient.id.href,
        inboxId: recipient.inboxId.href,
        sharedInbox: recipient.endpoints.sharedInbox.href,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        {
          id: "https://deletefollowee.example/users/bob",
          inboxId: "https://deletefollowee.example/users/bob/inbox",
          sharedInbox: "https://deletefollowee.example/inbox",
        },
        {
          id: "https://deletefollower.example/users/alice",
          inboxId: "https://deletefollower.example/users/alice/inbox",
          sharedInbox: "https://deletefollower.example/inbox",
        },
        {
          id: "https://deletepending.example/users/charlie",
          inboxId: "https://deletepending.example/users/charlie/inbox",
          sharedInbox: "https://deletepending.example/inbox",
        },
      ],
    );
    assert.deepEqual(sendObservedState, {
      accountExists: false,
      tombstoneUsername: "deleterenamed",
      preservedKeyTypes: ["RSASSA-PKCS1-v1_5"],
    });

    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(account, undefined);
    const actor = await tx.query.actorTable.findFirst({
      where: { id: target.actor.id },
    });
    assert.equal(actor, undefined);
    const deletedPosts = await tx.query.postTable.findMany({
      where: { id: { in: [replyPost.id, sharePost.id, quotePost.id] } },
    });
    assert.deepEqual(deletedPosts, []);

    const refreshedParent = await tx.query.postTable.findFirst({
      where: { id: parentPost.id },
    });
    assert.ok(refreshedParent != null);
    assert.equal(refreshedParent.repliesCount, 0);
    assert.equal(refreshedParent.sharesCount, 0);
    assert.equal(refreshedParent.quotesCount, 0);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: timelineViewer.account.id,
        postId: parentPost.id,
      },
    });
    assert.equal(timelineItem, undefined);

    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.ok(tombstone != null);
    assert.equal(tombstone.username, "deleterenamed");
    assert.equal(await isUsernameReserved(tx, "deleterenamed"), true);
    assert.equal(await isUsernameReserved(tx, " DeleteRenamed "), true);
    assert.equal(await isUsernameReserved(tx, "deletecurrent"), false);
    const preservedKeys = await tx.query.deletedAccountKeyTable.findMany({
      where: { accountId: target.account.id },
    });
    assert.equal(preservedKeys.length, 1);
    assert.equal(preservedKeys[0].type, "RSASSA-PKCS1-v1_5");
  });
});

test("deleteAccount() runs before-delete checks inside the deletion transaction", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const target = await insertAccountWithActor(tx, {
      username: "deletebeforecheck",
      name: "Delete Before Check",
      email: "deletebeforecheck@example.com",
    });
    let checked = false;

    await assert.rejects(
      () =>
        deleteAccount(fedCtx, target.account.id, {
          beforeDelete: async (deleteTx, account) => {
            checked = true;
            assert.equal(account.id, target.account.id);
            const visibleAccount = await deleteTx.query.accountTable.findFirst({
              where: { id: account.id },
            });
            assert.notEqual(visibleAccount, undefined);
            throw new Error("stop deletion");
          },
        }),
      /stop deletion/,
    );

    assert.equal(checked, true);
    assert.notEqual(
      await tx.query.accountTable.findFirst({
        where: { id: target.account.id },
      }),
      undefined,
    );
  });
});

test("deleteAccount() preserves Organization tombstones", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const sentActivities: unknown[][] = [];
    fedCtx.sendActivity = (async (...args: unknown[]) => {
      sentActivities.push(args);
    }) as typeof fedCtx.sendActivity;

    const target = await insertAccountWithActor(tx, {
      username: "deleteorg",
      name: "Delete Org",
      email: "deleteorg@example.com",
      kind: "organization",
      type: "Organization",
    });

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.equal(result?.accountId, target.account.id);
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.equal(tombstone?.formerType, "Organization");

    const activity = sentActivities[0]?.[2];
    assert.ok(activity instanceof Delete);
    const object = await activity.getObject({ ...fedCtx, suppressError: true });
    assert.ok(object instanceof Tombstone);
    assert.equal(object.formerType, Organization);
  });
});

test("database rejects account usernames reserved by deleted accounts", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "reserveddbsource",
      name: "Reserved DB Source",
      email: "reserved-db-source@example.com",
    });
    await tx.insert(deletedAccountTable).values({
      accountId: generateUuidV7(),
      username: "reserveddbtarget",
      actorIri: "http://localhost/ap/actors/reserveddbtarget",
      deleted: new Date("2026-06-19T00:00:00.000Z"),
    });

    let error: unknown;
    try {
      await tx.update(accountTable)
        .set({ username: "reserveddbtarget" })
        .where(eq(accountTable.id, account.account.id));
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(
      String((error as Error & { cause?: unknown }).cause),
      /account username is reserved by a deleted account/,
    );
  });
});

test("deleteAccount() ignores malformed remote delete recipients and clamps remote counts", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const sentActivities: unknown[][] = [];
    fedCtx.sendActivity = (async (...args: unknown[]) => {
      sentActivities.push(args);
    }) as typeof fedCtx.sendActivity;

    const target = await insertAccountWithActor(tx, {
      username: "deletemalformed",
      name: "Delete Malformed",
      email: "delete-malformed@example.com",
    });
    await tx.insert(instanceTable).values([
      { host: "delete-malformed.example" },
      { host: "delete-count-followee.example" },
      { host: "delete-count-follower.example" },
    ]);
    const malformedFolloweeId = generateUuidV7();
    await tx.insert(actorTable).values({
      id: malformedFolloweeId,
      iri: "https://delete-malformed.example/users/bad",
      type: "Person",
      username: "bad",
      instanceHost: "delete-malformed.example",
      handleHost: "delete-malformed.example",
      inboxUrl: "not a url",
    });
    const countedFolloweeId = generateUuidV7();
    await tx.insert(actorTable).values({
      id: countedFolloweeId,
      iri: "https://delete-count-followee.example/users/good",
      type: "Person",
      username: "good",
      instanceHost: "delete-count-followee.example",
      handleHost: "delete-count-followee.example",
      inboxUrl: "https://delete-count-followee.example/users/good/inbox",
      followersCount: 0,
    });
    const countedFollowerId = generateUuidV7();
    await tx.insert(actorTable).values({
      id: countedFollowerId,
      iri: "https://delete-count-follower.example/users/fan",
      type: "Person",
      username: "fan",
      instanceHost: "delete-count-follower.example",
      handleHost: "delete-count-follower.example",
      inboxUrl: "https://delete-count-follower.example/users/fan/inbox",
      followeesCount: 0,
    });
    await tx.insert(followingTable).values([
      {
        iri: "http://localhost/follows/deletemalformed-bad",
        followerId: target.actor.id,
        followeeId: malformedFolloweeId,
        accepted: new Date("2026-06-19T00:00:00.000Z"),
      },
      {
        iri: "http://localhost/follows/deletemalformed-good",
        followerId: target.actor.id,
        followeeId: countedFolloweeId,
        accepted: new Date("2026-06-19T00:00:01.000Z"),
      },
      {
        iri:
          "https://delete-count-follower.example/follows/fan-deletemalformed",
        followerId: countedFollowerId,
        followeeId: target.actor.id,
        accepted: new Date("2026-06-19T00:00:02.000Z"),
      },
    ]);

    await deleteAccount(fedCtx, target.account.id);

    assert.equal(sentActivities.length, 1);
    const recipients = sentActivities[0][1] as {
      id: URL;
    }[];
    assert.deepEqual(
      recipients.map((recipient) => recipient.id.href).sort(),
      [
        "https://delete-count-followee.example/users/good",
        "https://delete-count-follower.example/users/fan",
      ],
    );
    const refreshedFollowee = await tx.query.actorTable.findFirst({
      where: { id: countedFolloweeId },
    });
    assert.equal(refreshedFollowee?.followersCount, 0);
    const refreshedFollower = await tx.query.actorTable.findFirst({
      where: { id: countedFollowerId },
    });
    assert.equal(refreshedFollower?.followeesCount, 0);
  });
});

test("deleteAccount() returns undefined when the account actor is missing", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const accountId = generateUuidV7();
    await tx.insert(accountTable).values({
      id: accountId,
      username: "deleteorphan",
      name: "Delete Orphan",
      bio: "",
      leftInvitations: 0,
    });

    assert.equal(await deleteAccount(fedCtx, accountId), undefined);
  });
});

test("deleteAccount() refreshes denormalized interaction state", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const survivor = await insertAccountWithActor(tx, {
      username: "deletesurvivor",
      name: "Delete Survivor",
      email: "deletesurvivor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deleteinteractions",
      name: "Delete Interactions",
      email: "deleteinteractions@example.com",
    });
    const bystander = await insertAccountWithActor(tx, {
      username: "deletebystander",
      name: "Delete Bystander",
      email: "deletebystander@example.com",
    });
    const accepted = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(followingTable).values([
      {
        iri: `http://localhost/follows/${generateUuidV7()}`,
        followerId: target.actor.id,
        followeeId: survivor.actor.id,
        accepted,
      },
      {
        iri: `http://localhost/follows/${generateUuidV7()}`,
        followerId: bystander.actor.id,
        followeeId: target.actor.id,
        accepted,
      },
    ]);
    await tx.update(actorTable)
      .set({ followersCount: 1 })
      .where(eq(actorTable.id, survivor.actor.id));
    await tx.update(actorTable)
      .set({ followeesCount: 1 })
      .where(eq(actorTable.id, bystander.actor.id));
    await createFollowNotification(
      tx,
      survivor.account.id,
      target.actor,
      accepted,
    );

    const { post } = await insertNotePost(tx, {
      account: survivor.account,
      content: "Surviving post",
    });
    await react(
      fedCtx,
      target.account,
      { ...post, actor: survivor.actor },
      "🎉",
    );
    await react(
      fedCtx,
      bystander.account,
      { ...post, actor: survivor.actor },
      "🎉",
    );

    await tx.insert(pollTable).values({
      postId: post.id,
      multiple: false,
      votersCount: 2,
      ends: new Date("2026-04-16T00:00:00.000Z"),
    });
    await tx.insert(pollOptionTable).values([
      { postId: post.id, index: 0, title: "Delete", votesCount: 1 },
      { postId: post.id, index: 1, title: "Keep", votesCount: 1 },
    ]);
    await tx.insert(pollVoteTable).values([
      { postId: post.id, optionIndex: 0, actorId: target.actor.id },
      { postId: post.id, optionIndex: 1, actorId: bystander.actor.id },
    ]);

    await deleteAccount(fedCtx, target.account.id);

    const refreshedSurvivor = await tx.query.actorTable.findFirst({
      where: { id: survivor.actor.id },
    });
    assert.equal(refreshedSurvivor?.followersCount, 0);

    const refreshedBystander = await tx.query.actorTable.findFirst({
      where: { id: bystander.actor.id },
    });
    assert.equal(refreshedBystander?.followeesCount, 0);

    const refreshedPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.deepEqual(refreshedPost?.reactionsCounts, { "🎉": 1 });

    const reactNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: survivor.account.id,
        type: "react",
        postId: post.id,
      },
    });
    assert.deepEqual(reactNotification?.actorIds, [bystander.actor.id]);

    const followNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: survivor.account.id,
        type: "follow",
      },
    });
    assert.equal(followNotification, undefined);

    const refreshedPoll = await tx.query.pollTable.findFirst({
      where: { postId: post.id },
    });
    assert.equal(refreshedPoll?.votersCount, 1);

    const refreshedOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: post.id },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(
      refreshedOptions.map((option) => option.votesCount),
      [0, 1],
    );
  });
});

test("deleteAccount() refreshes news scores for Article boost interactions", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "deletearticleauthor",
      name: "Delete Article Author",
      email: "delete-article-author@example.com",
    });
    const booster = await insertAccountWithActor(tx, {
      username: "deletearticlebooster",
      name: "Delete Article Booster",
      email: "delete-article-booster@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletearticleinteractor",
      name: "Delete Article Interactor",
      email: "delete-article-interactor@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "http://localhost/@deletearticleauthor/article",
    });
    const { post: article } = await insertNotePost(tx, {
      account: author.account,
      published: new Date("2026-05-10T00:00:00.000Z"),
      link: { id: link.id, url: link.url },
    });
    await tx.update(postTable).set({
      type: "Article",
      noteSourceId: null,
      name: "Article",
      url: link.url,
    }).where(eq(postTable.id, article.id));
    const { post: boost } = await insertNotePost(tx, {
      account: booster.account,
      sharedPostId: article.id,
      published: new Date("2026-05-11T00:00:00.000Z"),
    });
    await insertNotePost(tx, {
      account: target.account,
      replyTargetId: boost.id,
      published: new Date("2026-05-12T00:00:00.000Z"),
    });
    await react(
      fedCtx,
      target.account,
      { ...boost, actor: booster.actor },
      "🎉",
    );
    await recomputeNewsScores(tx, { linkIds: [link.id] });
    const before = await tx.query.postLinkTable.findFirst({
      where: { id: link.id },
    });
    assert.ok(before != null);
    assert.ok(before.weightedMass > 2 * NEWS_W_SHARE);

    await deleteAccount(fedCtx, target.account.id);

    const after = await tx.query.postLinkTable.findFirst({
      where: { id: link.id },
    });
    assert.ok(after != null);
    assertAlmostEquals(after.weightedMass, 2 * NEWS_W_SHARE, 1e-9);
  });
});

test("deleteAccount() clears article translation attributions", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "deletearticleowner",
      name: "Delete Article Owner",
      email: "delete-article-owner@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletearticletranslator",
      name: "Delete Article Translator",
      email: "delete-article-translator@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-05-20T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "delete-translation-attribution",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Original title",
        content: "Original content",
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ko",
        title: "Requested translation",
        content: "Requested translated content",
        originalLanguage: "en",
        translationRequesterId: target.account.id,
        beingTranslated: false,
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ja",
        title: "Human translation",
        content: "Human translated content",
        originalLanguage: "en",
        translatorId: target.account.id,
        beingTranslated: false,
        published,
        updated: published,
      },
    ]);

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.equal(result?.accountId, target.account.id);
    const contents = await tx.query.articleContentTable.findMany({
      where: { sourceId },
      orderBy: { language: "asc" },
    });
    assert.deepEqual(
      contents.map((content) => ({
        content: content.content,
        language: content.language,
        originalLanguage: content.originalLanguage,
        translationRequesterId: content.translationRequesterId,
        translatorId: content.translatorId,
      })),
      [
        {
          content: "Original content",
          language: "en",
          originalLanguage: null,
          translationRequesterId: null,
          translatorId: null,
        },
        {
          content: "Human translated content",
          language: "ja",
          originalLanguage: "en",
          translationRequesterId: null,
          translatorId: null,
        },
        {
          content: "Requested translated content",
          language: "ko",
          originalLanguage: "en",
          translationRequesterId: null,
          translatorId: null,
        },
      ],
    );
  });
});

test("deleteAccount() backfills missing actor keys before tombstoning", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const target = await insertAccountWithActor(tx, {
      username: "deletepartialkeys",
      name: "Delete Partial Keys",
      email: "delete-partial-keys@example.com",
    });
    await tx.insert(accountKeyTable).values({
      accountId: target.account.id,
      type: "RSASSA-PKCS1-v1_5",
      public: { kty: "test-rsa-public" },
      private: { kty: "test-rsa-private" },
    });
    let keyPairsRequested = false;
    (fedCtx as unknown as {
      getActorKeyPairs: (identifier: string) => Promise<unknown[]>;
    }).getActorKeyPairs = async (identifier) => {
      keyPairsRequested = true;
      assert.equal(identifier, target.account.id);
      await tx.insert(accountKeyTable).values({
        accountId: target.account.id,
        type: "Ed25519",
        public: { kty: "test-ed25519-public" },
        private: { kty: "test-ed25519-private" },
      }).onConflictDoNothing();
      return [];
    };

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.equal(result?.accountId, target.account.id);
    assert.equal(keyPairsRequested, true);
    const preservedKeys = await tx.query.deletedAccountKeyTable.findMany({
      where: { accountId: target.account.id },
      orderBy: { type: "asc" },
    });
    assert.deepEqual(
      preservedKeys.map((key) => key.type),
      ["Ed25519", "RSASSA-PKCS1-v1_5"],
    );
  });
});

test("deleteAccount() rolls back when actor Delete enqueue fails", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.sendActivity = (() =>
      Promise.reject(
        new Error("queue unavailable"),
      )) as typeof fedCtx.sendActivity;
    const target = await insertAccountWithActor(tx, {
      username: "deletequeuefail",
      name: "Delete Queue Fail",
      email: "deletequeuefail@example.com",
    });

    await assert.rejects(
      deleteAccount(fedCtx, target.account.id),
      /queue unavailable/,
    );

    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(account?.id, target.account.id);
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.equal(tombstone, undefined);
  });
});

test("deleteAccount() refuses accounts linked to moderation audit records", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    let sent = false;
    let keyPairsRequested = false;
    (fedCtx as unknown as {
      getActorKeyPairs: (identifier: string) => Promise<unknown[]>;
    }).getActorKeyPairs = () => {
      keyPairsRequested = true;
      return Promise.resolve([]);
    };
    fedCtx.sendActivity = (() => {
      sent = true;
      return Promise.resolve(undefined);
    }) as typeof fedCtx.sendActivity;
    const target = await insertAccountWithActor(tx, {
      username: "deleteaudit",
      name: "Delete Audit",
      email: "deleteaudit@example.com",
    });
    await tx.insert(flagCaseTable).values({
      id: generateUuidV7(),
      targetActorId: target.actor.id,
      status: "pending",
    });

    await assert.rejects(
      () => deleteAccount(fedCtx, target.account.id),
      AccountDeletionUnavailableError,
    );

    assert.equal(sent, false);
    assert.equal(keyPairsRequested, false);
    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.ok(account != null);
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.equal(tombstone, undefined);
  });
});

test("deleteAccount() ignores unrelated moderation audit records", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.sendActivity = (() =>
      Promise.resolve(undefined)) as typeof fedCtx.sendActivity;
    const target = await insertAccountWithActor(tx, {
      username: "deleteauditfree",
      name: "Delete Audit Free",
      email: "deleteauditfree@example.com",
    });
    const unrelated = await insertAccountWithActor(tx, {
      username: "deleteauditother",
      name: "Delete Audit Other",
      email: "deleteauditother@example.com",
    });
    const flagCaseId = generateUuidV7();
    await tx.insert(flagCaseTable).values({
      id: flagCaseId,
      targetActorId: unrelated.actor.id,
      status: "pending",
    });

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.equal(result?.accountId, target.account.id);
    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(account, undefined);
    const flagCase = await tx.query.flagCaseTable.findFirst({
      where: { id: flagCaseId },
    });
    assert.equal(flagCase?.targetActorId, unrelated.actor.id);
  });
});

test("deleteAccount() avoids duplicate follow notification actor sets", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.sendActivity = (() =>
      Promise.resolve(undefined)) as typeof fedCtx.sendActivity;
    const recipient = await insertAccountWithActor(tx, {
      username: "deletefollowrecipient",
      name: "Delete Follow Recipient",
      email: "deletefollowrecipient@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletefollowtarget",
      name: "Delete Follow Target",
      email: "deletefollowtarget@example.com",
    });
    const survivor = await insertAccountWithActor(tx, {
      username: "deletefollowsurvivor",
      name: "Delete Follow Survivor",
      email: "deletefollowsurvivor@example.com",
    });

    await tx.insert(notificationTable).values([
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [survivor.actor.id],
      },
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [target.actor.id, survivor.actor.id],
      },
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [survivor.actor.id, target.actor.id],
      },
    ]);

    await deleteAccount(fedCtx, target.account.id);

    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: recipient.account.id,
        type: "follow",
      },
    });
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].actorIds, [survivor.actor.id]);
  });
});

test("deleteAccount() removes follow notifications emptied by actor removal", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.sendActivity = (() =>
      Promise.resolve(undefined)) as typeof fedCtx.sendActivity;
    const recipient = await insertAccountWithActor(tx, {
      username: "deleteemptyrecipient",
      name: "Delete Empty Recipient",
      email: "deleteemptyrecipient@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deleteemptytarget",
      name: "Delete Empty Target",
      email: "deleteemptytarget@example.com",
    });

    await tx.insert(notificationTable).values([
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [],
      },
      {
        id: generateUuidV7(),
        accountId: recipient.account.id,
        type: "follow",
        actorIds: [target.actor.id],
      },
    ]);

    await deleteAccount(fedCtx, target.account.id);

    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: recipient.account.id,
        type: "follow",
      },
    });
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].actorIds, []);
  });
});

import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import { buildPushNotificationPayload } from "./push-notification.ts";
import { accountTable, postTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("buildPushNotificationPayload() includes previews according to account policy", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushpayload",
      name: "Push Payload",
      email: "pushpayload@example.com",
    });
    const actor = await insertRemoteActor(tx, {
      username: "sender",
      name: "Sender",
      host: "remote.example",
    });
    const { post: publicPost } = await insertNotePost(tx, {
      account,
      actorId: actor.id,
      contentHtml: "<p>Visible <strong>preview</strong> text</p>",
      visibility: "public",
    });
    const { post: followersPost } = await insertNotePost(tx, {
      account,
      actorId: actor.id,
      contentHtml: "<p>Followers only preview</p>",
      visibility: "followers",
    });

    const publicPayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: publicPost.id,
    });
    assert.equal(
      publicPayload.body,
      "Sender mentioned you.\nVisible preview text",
    );

    const followersPayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: followersPost.id,
    });
    assert.doesNotMatch(followersPayload.body, /Followers only preview/);

    await tx.update(accountTable)
      .set({ pushNotificationPreviewPolicy: "all" })
      .where(eq(accountTable.id, account.id));
    const allPayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: followersPost.id,
    });
    assert.match(allPayload.body, /Followers only preview/);

    await tx.update(postTable)
      .set({ sensitive: true })
      .where(eq(postTable.id, publicPost.id));
    await tx.update(accountTable)
      .set({ pushNotificationPreviewPolicy: "public_only" })
      .where(eq(accountTable.id, account.id));
    const sensitivePayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: publicPost.id,
    });
    assert.doesNotMatch(sensitivePayload.body, /Visible preview text/);

    await tx.update(accountTable)
      .set({ pushNotificationPreviewPolicy: "none" })
      .where(eq(accountTable.id, account.id));
    const nonePayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: followersPost.id,
    });
    assert.doesNotMatch(nonePayload.body, /Followers only preview/);
  });
});

test("buildPushNotificationPayload() caps truncated previews", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushlength",
      name: "Push Length",
      email: "pushlength@example.com",
    });
    const actor = await insertRemoteActor(tx, {
      username: "sender",
      name: "Sender",
      host: "remote.example",
    });
    const { post } = await insertNotePost(tx, {
      account,
      actorId: actor.id,
      contentHtml: `<p>${"x".repeat(200)}</p>`,
      visibility: "public",
    });

    const payload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
      postId: post.id,
    });
    const preview = payload.body.split("\n")[1];

    assert.equal(typeof preview, "string");
    assert.equal(preview.length, 140);
    assert.match(preview, /\.\.\.$/);
  });
});

test("buildPushNotificationPayload() caps actor labels", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushactorlength",
      name: "Push Actor Length",
      email: "pushactorlength@example.com",
    });
    const actor = await insertRemoteActor(tx, {
      username: "longsender",
      name: "A".repeat(200),
      host: "remote.example",
    });

    const payload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "mention",
      actorId: actor.id,
    });
    const actorLabel = payload.body.replace(" mentioned you.", "");

    assert.equal(actorLabel.length, 80);
    assert.equal(actorLabel, `${"A".repeat(77)}...`);
  });
});

test("buildPushNotificationPayload() localizes titles and bodies", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushlocale",
      name: "Push Locale",
      email: "pushlocale@example.com",
    });
    const actor = await insertRemoteActor(tx, {
      username: "sender",
      name: "Sender",
      host: "remote.example",
    });

    await tx.update(accountTable)
      .set({ locales: ["ko-KR"] })
      .where(eq(accountTable.id, account.id));
    const koreanPayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "quote",
      actorId: actor.id,
    });
    assert.equal(koreanPayload.title, "새 인용");
    assert.equal(
      koreanPayload.body,
      "Sender 님이 회원님의 콘텐츠를 인용했습니다",
    );

    await tx.update(accountTable)
      .set({ locales: ["zh-HK"] })
      .where(eq(accountTable.id, account.id));
    const traditionalChinesePayload = await buildPushNotificationPayload(tx, {
      accountId: account.id,
      notificationId: generateUuidV7(),
      type: "react",
      actorId: actor.id,
      emoji: "👍",
    });
    assert.equal(traditionalChinesePayload.title, "新的反應");
    assert.equal(
      traditionalChinesePayload.body,
      "Sender 用 👍 對你的內容做出了反應",
    );
  });
});

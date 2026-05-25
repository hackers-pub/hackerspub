import assert from "node:assert/strict";
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
    assert.match(publicPayload.body, /Visible preview text/);

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

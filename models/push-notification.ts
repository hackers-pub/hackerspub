import { eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { stripHtml } from "./html.ts";
import {
  accountTable,
  actorTable,
  type CustomEmoji,
  type NotificationType,
  postTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export interface PushNotificationPayloadOptions {
  accountId: Uuid;
  notificationId: Uuid;
  type: NotificationType;
  actorId: Uuid;
  postId?: Uuid | null;
  emoji?: string | CustomEmoji | null;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  data: {
    notificationId: Uuid;
    type: NotificationType;
    actorId: Uuid;
    postId?: Uuid;
  };
}

function actorName(
  actor: Pick<typeof actorTable.$inferSelect, "name" | "handle" | "username">,
): string {
  return actor.name?.trim() || actor.handle || actor.username;
}

function emojiText(emoji: string | CustomEmoji | null | undefined): string {
  if (emoji == null) return "reacted";
  return typeof emoji === "string"
    ? `reacted with ${emoji}`
    : `reacted with ${emoji.name}`;
}

function truncatePreview(text: string, maxLength = 140): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${Array.from(normalized).slice(0, maxLength - 1).join("")}...`;
}

function postPreview(
  account: Pick<
    typeof accountTable.$inferSelect,
    "pushNotificationPreviewPolicy"
  >,
  post:
    | Pick<
      typeof postTable.$inferSelect,
      "visibility" | "sensitive" | "summary" | "contentHtml"
    >
    | null,
): string | null {
  if (post == null) return null;
  switch (account.pushNotificationPreviewPolicy) {
    case "none":
      return null;
    case "public_only":
      if (
        post.sensitive ||
        (post.visibility !== "public" && post.visibility !== "unlisted")
      ) {
        return null;
      }
      break;
    case "all":
      break;
  }

  const text = post.summary?.trim() || stripHtml(post.contentHtml);
  return text === "" ? null : truncatePreview(text);
}

function genericBody(
  type: NotificationType,
  name: string,
  emoji: string | CustomEmoji | null | undefined,
): string {
  switch (type) {
    case "follow":
      return `${name} followed you.`;
    case "mention":
      return `${name} mentioned you.`;
    case "reply":
      return `${name} replied to you.`;
    case "share":
      return `${name} shared your post.`;
    case "quote":
      return `${name} quoted your post.`;
    case "react":
      return `${name} ${emojiText(emoji)}.`;
    case "shared_post_updated":
      return `${name} updated a post you shared.`;
    case "quoted_post_updated":
      return `${name} updated a post you quoted.`;
  }
}

function titleForType(type: NotificationType): string {
  switch (type) {
    case "follow":
      return "New follower";
    case "mention":
      return "New mention";
    case "reply":
      return "New reply";
    case "share":
      return "New share";
    case "quote":
      return "New quote";
    case "react":
      return "New reaction";
    case "shared_post_updated":
    case "quoted_post_updated":
      return "Post updated";
  }
}

export async function buildPushNotificationPayload(
  db: Database,
  options: PushNotificationPayloadOptions,
): Promise<PushNotificationPayload> {
  const [accountRows, actorRows, postRows] = await Promise.all([
    db.select({
      pushNotificationPreviewPolicy: accountTable.pushNotificationPreviewPolicy,
    }).from(accountTable).where(eq(accountTable.id, options.accountId))
      .limit(1),
    db.select({
      name: actorTable.name,
      handle: actorTable.handle,
      username: actorTable.username,
    }).from(actorTable).where(eq(actorTable.id, options.actorId)).limit(1),
    options.postId == null ? Promise.resolve([]) : db.select({
      visibility: postTable.visibility,
      sensitive: postTable.sensitive,
      summary: postTable.summary,
      contentHtml: postTable.contentHtml,
    }).from(postTable).where(eq(postTable.id, options.postId)).limit(1),
  ]);

  const account = accountRows[0] ?? {
    pushNotificationPreviewPolicy: "public_only",
  };
  const name = actorRows[0] == null ? "Someone" : actorName(actorRows[0]);
  const preview = postPreview(account, postRows[0] ?? null);

  return {
    title: titleForType(options.type),
    body: preview == null
      ? genericBody(options.type, name, options.emoji)
      : `${genericBody(options.type, name, options.emoji)} ${preview}`,
    url: "/notifications",
    data: {
      notificationId: options.notificationId,
      type: options.type,
      actorId: options.actorId,
      ...(options.postId == null ? {} : { postId: options.postId }),
    },
  };
}

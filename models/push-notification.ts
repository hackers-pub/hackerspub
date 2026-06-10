import { eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { stripHtml } from "./html.ts";
import { negotiateLocale } from "./i18n.ts";
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
  return truncatePreview(
    actor.name?.trim() || actor.handle || actor.username,
    80,
  );
}

function emojiText(emoji: string | CustomEmoji | null | undefined): string {
  if (emoji == null) return "";
  return typeof emoji === "string" ? emoji : emoji.name;
}

type PushNotificationLocale = keyof typeof PUSH_NOTIFICATION_MESSAGES;

const PUSH_NOTIFICATION_MESSAGES = {
  "en-US": {
    someone: "Someone",
    title: {
      follow: "New follower",
      mention: "New mention",
      reply: "New reply",
      share: "New share",
      quote: "New quote",
      react: "New reaction",
      shared_post_updated: "Post updated",
      quoted_post_updated: "Post updated",
      poll_ended: "Poll ended",
    },
    body: {
      follow: (name: string) => `${name} followed you.`,
      mention: (name: string) => `${name} mentioned you.`,
      reply: (name: string) => `${name} replied to your post.`,
      share: (name: string) => `${name} shared your post.`,
      quote: (name: string) => `${name} quoted your post.`,
      react: (name: string, emoji: string) =>
        emoji === ""
          ? `${name} reacted to your post.`
          : `${name} reacted to your post with ${emoji}.`,
      shared_post_updated: (name: string) =>
        `${name} updated a post you shared.`,
      quoted_post_updated: (name: string) =>
        `${name} updated a post you quoted.`,
      poll_ended: (name: string) => `${name}'s poll ended.`,
    },
  },
  "ja-JP": {
    someone: "誰か",
    title: {
      follow: "新しいフォロワー",
      mention: "新しいメンション",
      reply: "新しい返信",
      share: "新しい共有",
      quote: "新しい引用",
      react: "新しいリアクション",
      shared_post_updated: "コンテンツが更新されました",
      quoted_post_updated: "コンテンツが更新されました",
      poll_ended: "投票が終了しました",
    },
    body: {
      follow: (name: string) => `${name}さんがあなたをフォローしました`,
      mention: (name: string) => `${name}さんがあなたにメンションしました`,
      reply: (name: string) => `${name}さんがあなたのコンテンツに返信しました`,
      share: (name: string) => `${name}さんがあなたのコンテンツを共有しました`,
      quote: (name: string) => `${name}さんがあなたのコンテンツを引用しました`,
      react: (name: string, emoji: string) =>
        emoji === ""
          ? `${name}さんがあなたのコンテンツにリアクションしました`
          : `${name}さんがあなたのコンテンツに${emoji}でリアクションしました`,
      shared_post_updated: (name: string) =>
        `${name}さんがあなたが共有したコンテンツを更新しました`,
      quoted_post_updated: (name: string) =>
        `${name}さんがあなたが引用したコンテンツを更新しました`,
      poll_ended: (name: string) => `${name}さんの投票が終了しました`,
    },
  },
  "ko-KR": {
    someone: "누군가",
    title: {
      follow: "새 팔로워",
      mention: "새 멘션",
      reply: "새 댓글",
      share: "새 공유",
      quote: "새 인용",
      react: "새 반응",
      shared_post_updated: "콘텐츠가 업데이트됨",
      quoted_post_updated: "콘텐츠가 업데이트됨",
      poll_ended: "투표 종료됨",
    },
    body: {
      follow: (name: string) => `${name} 님이 팔로했습니다`,
      mention: (name: string) => `${name} 님이 언급했습니다`,
      reply: (name: string) =>
        `${name} 님이 회원님의 콘텐츠에 댓글을 달았습니다`,
      share: (name: string) => `${name} 님이 회원님의 콘텐츠를 공유했습니다`,
      quote: (name: string) => `${name} 님이 회원님의 콘텐츠를 인용했습니다`,
      react: (name: string, emoji: string) =>
        emoji === ""
          ? `${name} 님이 회원님의 콘텐츠에 반응했습니다`
          : `${name} 님이 회원님의 콘텐츠에 ${emoji}(으)로 반응했습니다`,
      shared_post_updated: (name: string) =>
        `${name} 님이 회원님이 공유한 콘텐츠를 업데이트했습니다`,
      quoted_post_updated: (name: string) =>
        `${name} 님이 회원님이 인용한 콘텐츠를 업데이트했습니다`,
      poll_ended: (name: string) => `${name} 님의 투표가 종료되었습니다`,
    },
  },
  "zh-CN": {
    someone: "有人",
    title: {
      follow: "新的关注者",
      mention: "新的提及",
      reply: "新的回复",
      share: "新的转发",
      quote: "新的引用",
      react: "新的反应",
      shared_post_updated: "内容已更新",
      quoted_post_updated: "内容已更新",
      poll_ended: "投票已结束",
    },
    body: {
      follow: (name: string) => `${name} 关注了你`,
      mention: (name: string) => `${name} 提及了你`,
      reply: (name: string) => `${name} 回复了你的内容`,
      share: (name: string) => `${name} 转发了你的内容`,
      quote: (name: string) => `${name} 引用了你的内容`,
      react: (name: string, emoji: string) =>
        emoji === ""
          ? `${name} 对你的内容做出了反应`
          : `${name} 用 ${emoji} 对你的内容做出了反应`,
      shared_post_updated: (name: string) => `${name} 更新了你转发过的内容`,
      quoted_post_updated: (name: string) => `${name} 更新了你引用过的内容`,
      poll_ended: (name: string) => `${name} 的投票已结束`,
    },
  },
  "zh-TW": {
    someone: "有人",
    title: {
      follow: "新的關注者",
      mention: "新的提及",
      reply: "新的回覆",
      share: "新的轉貼",
      quote: "新的引用",
      react: "新的反應",
      shared_post_updated: "內容已更新",
      quoted_post_updated: "內容已更新",
      poll_ended: "投票已結束",
    },
    body: {
      follow: (name: string) => `${name} 關注了你`,
      mention: (name: string) => `${name} 提及了你`,
      reply: (name: string) => `${name} 回覆了你的內容`,
      share: (name: string) => `${name} 轉貼了你的內容`,
      quote: (name: string) => `${name} 引用了你的內容`,
      react: (name: string, emoji: string) =>
        emoji === ""
          ? `${name} 對你的內容做出了反應`
          : `${name} 用 ${emoji} 對你的內容做出了反應`,
      shared_post_updated: (name: string) => `${name} 更新了你轉貼過的內容`,
      quoted_post_updated: (name: string) => `${name} 更新了你引用過的內容`,
      poll_ended: (name: string) => `${name} 的投票已結束`,
    },
  },
} satisfies Record<
  string,
  {
    someone: string;
    title: Record<NotificationType, string>;
    body: Record<NotificationType, (name: string, emoji: string) => string>;
  }
>;

const PUSH_NOTIFICATION_LOCALES = Object.keys(
  PUSH_NOTIFICATION_MESSAGES,
) as PushNotificationLocale[];

function selectPushNotificationLocale(
  locales: readonly string[] | null | undefined,
): PushNotificationLocale {
  const matched = locales == null
    ? undefined
    : negotiateLocale(locales, PUSH_NOTIFICATION_LOCALES);
  return (matched?.baseName as PushNotificationLocale | undefined) ?? "en-US";
}

function truncatePreview(text: string, maxLength = 140): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  if (maxLength <= 3) return ".".repeat(Math.max(maxLength, 0));
  return `${characters.slice(0, maxLength - 3).join("")}...`;
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
  locale: PushNotificationLocale,
  type: NotificationType,
  name: string,
  emoji: string | CustomEmoji | null | undefined,
): string {
  return PUSH_NOTIFICATION_MESSAGES[locale].body[type](name, emojiText(emoji));
}

function titleForType(
  locale: PushNotificationLocale,
  type: NotificationType,
): string {
  return PUSH_NOTIFICATION_MESSAGES[locale].title[type];
}

export async function buildPushNotificationPayload(
  db: Database,
  options: PushNotificationPayloadOptions,
): Promise<PushNotificationPayload> {
  const [accountRows, actorRows, postRows] = await Promise.all([
    db.select({
      locales: accountTable.locales,
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
    locales: null,
    pushNotificationPreviewPolicy: "public_only",
  };
  const locale = selectPushNotificationLocale(account.locales);
  const name = actorRows[0] == null
    ? PUSH_NOTIFICATION_MESSAGES[locale].someone
    : actorName(actorRows[0]);
  const preview = postPreview(account, postRows[0] ?? null);
  const body = genericBody(locale, options.type, name, options.emoji);

  return {
    title: titleForType(locale, options.type),
    body: preview == null ? body : `${body}\n${preview}`,
    url: "/notifications",
    data: {
      notificationId: options.notificationId,
      type: options.type,
      actorId: options.actorId,
      ...(options.postId == null ? {} : { postId: options.postId }),
    },
  };
}

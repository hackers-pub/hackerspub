import { escape } from "@std/html/entities";
import { eq, sql } from "drizzle-orm";
import { page } from "fresh";
import { Excerpt } from "../components/Excerpt.tsx";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import { db } from "../db.ts";
import { Timestamp } from "../islands/Timestamp.tsx";
import { getAvatarUrl } from "../models/avatar.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import {
  getNotificationActors,
  getNotifications,
} from "../models/notification.ts";
import { isArticleLike } from "../models/post.ts";
import {
  accountTable,
  type Actor,
  notificationTable,
} from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { define } from "../utils.ts";

const WINDOW = 20;

export const handler = define.handlers(async (ctx) => {
  // Only logged-in users can see notifications
  if (ctx.state.account == null) return ctx.redirect("/sign");

  if (ctx.req.headers.get("Accept") === "application/json") {
    const result = await db.execute(sql`
      SELECT
        ${accountTable.notificationRead} IS NULL OR
        EXISTS (
          SELECT 1
          FROM ${notificationTable}
          WHERE ${notificationTable.accountId} = ${accountTable.id}
            AND ${notificationTable.created} > ${accountTable.notificationRead}
          LIMIT 1
        ) AS unread
      FROM ${accountTable}
      WHERE ${accountTable.id} = ${ctx.state.account.id}
    `);
    return new Response(JSON.stringify(result[0].unread), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  const lastRead = ctx.state.account.notificationRead;
  const now = new Date();
  await db.update(accountTable)
    .set({ notificationRead: now })
    .where(eq(accountTable.id, ctx.state.account.id));

  const pageNum = parseInt(ctx.url.searchParams.get("page") || "1", 10);
  const offset = (pageNum - 1) * WINDOW;

  // Get notifications for the current user
  const notifications = await getNotifications(
    db,
    ctx.state.account.id,
    now,
    WINDOW,
    offset,
  );

  // Extract all actor IDs from the notifications
  const actorIdSet = new Set<Uuid>();
  for (const notification of notifications) {
    notification.actorIds.forEach((id) => actorIdSet.add(id));
  }
  const actorIds = [...actorIdSet];

  // Get all actors involved in the notifications
  const actors = await getNotificationActors(db, actorIds);
  const actorsById = Object.fromEntries(
    actors.map((actor) => [actor.id, actor]),
  );

  const { t } = ctx.state;
  ctx.state.title = `Hackers' Pub: ${t("notification.title")}`;

  // Calculate next page URL if there are more results
  const nextHref = notifications.length === WINDOW
    ? `${ctx.url.pathname}?page=${pageNum + 1}`
    : undefined;

  return page<NotificationsProps>({
    lastRead,
    notifications,
    actorsById,
    nextHref,
  });
});

interface NotificationsProps {
  lastRead: Date | null;
  notifications: Awaited<ReturnType<typeof getNotifications>>;
  actorsById: Record<Uuid, Actor>;
  nextHref?: string;
}

export default define.page<typeof handler, NotificationsProps>(
  (
    {
      state: { language },
      data: { lastRead, notifications, actorsById, nextHref },
    },
  ) => {
    return (
      <main>
        <PageTitle>
          <Msg $key="notification.title" />
        </PageTitle>

        {notifications.length === 0
          ? (
            <p class="text-center py-8 text-gray-600 dark:text-gray-400">
              <Msg $key="notification.empty" />
            </p>
          )
          : (
            <div class="space-y-4">
              {notifications.map((notification) => {
                // Get actors involved in this notification
                const notificationActors = notification.actorIds
                  .map((id) => actorsById[id])
                  .filter(Boolean);

                const lastActor = notificationActors.pop();
                if (lastActor == null) {
                  return null;
                }

                // Render different UI based on notification type
                switch (notification.type) {
                  case "follow":
                    return (
                      <div
                        key={notification.id}
                        class={`
                          p-4 bg-stone-100 dark:bg-stone-800
                          ${
                          lastRead == null || lastRead < notification.created
                            ? "border border-stone-400 dark:border-stone-600"
                            : ""
                        }
                        `}
                      >
                        <div class="flex items-center gap-2">
                          <p>
                            <Msg
                              $key="notification.followedYou"
                              actor={<NotificationActor actor={lastActor} />}
                            />
                          </p>
                          <Timestamp
                            value={notification.created}
                            locale={language}
                            class="shrink-0 text-sm text-stone-500 ml-auto"
                          />
                        </div>
                      </div>
                    );

                  case "mention":
                  case "reply":
                  case "share":
                  // deno-lint-ignore no-case-declarations
                  case "quote":
                    // These notifications have an associated post
                    if (!notification.post) return null;
                    const { post } = notification;

                    return (
                      <div
                        key={notification.id}
                        class={`
                          p-4 bg-stone-100 dark:bg-stone-800
                          ${
                          lastRead == null || lastRead < notification.created
                            ? "border border-stone-400 dark:border-stone-600"
                            : ""
                        }
                        `}
                      >
                        <div class="flex items-center">
                          <p>
                            <Msg
                              $key={notification.type === "mention"
                                ? "notification.mentionedYou"
                                : notification.type === "reply"
                                ? "notification.repliedToYourPost"
                                : notification.type === "share"
                                ? "notification.sharedYourPost"
                                : "notification.quotedYourPost"}
                              count={notificationActors.length}
                              actor={<NotificationActor actor={lastActor} />}
                            />
                          </p>
                          <Timestamp
                            value={notification.created}
                            locale={language}
                            class="shrink-0 text-sm text-stone-500 ml-auto"
                          />
                        </div>

                        <a
                          href={post.articleSourceId == null &&
                              post.noteSourceId == null
                            ? `/${post.actor.handle}/${post.id}`
                            : post.url ?? post.iri}
                          class="block mt-4"
                        >
                          {isArticleLike(post) ? post.name : undefined}
                          <Excerpt
                            lang={post.language}
                            html={post.contentHtml}
                            emojis={post.emojis}
                          />
                        </a>
                      </div>
                    );
                }
              })}
            </div>
          )}

        <PostPagination nextHref={nextHref} />
      </main>
    );
  },
);

function NotificationActor({ actor }: { actor: Actor }) {
  return (
    <a
      href={actor.accountId ? `/@${actor.username}` : `/${actor.handle}`}
      title={`${actor.name ?? actor.username}\n${actor.handle}`}
      class="text-black dark:text-white font-bold"
    >
      <img src={getAvatarUrl(actor)} class="w-5 h-5 float-left mr-1" />
      {actor.name == null ? actor.username : (
        <span
          dangerouslySetInnerHTML={{
            __html: renderCustomEmojis(
              escape(actor.name),
              actor.emojis,
            ),
          }}
        />
      )}
      <span class="opacity-50 ml-1 font-normal before:content-['('] after:content-[')']">
        {actor.handle}
      </span>
    </a>
  );
}

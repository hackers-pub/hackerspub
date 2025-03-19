import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Feed } from "feed";
import { db } from "../../db.ts";
import { getAvatarUrl } from "../../models/account.ts";
import { stripHtml } from "../../models/html.ts";
import {
  accountTable,
  postMediumTable,
  postTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

const WINDOW = 50;

export const handler = define.handlers(async (ctx) => {
  const { username } = ctx.params;
  if (username.includes("@")) return ctx.next();
  const account = await db.query.accountTable.findFirst({
    with: { actor: true, emails: true },
    where: eq(accountTable.username, username),
  });
  if (account == null) return ctx.next();
  const articlesOnly = ctx.url.searchParams.has("articles");
  const canonicalUrl =
    `${ctx.state.canonicalOrigin}/@${account.username}/feed.xml${
      articlesOnly ? "?articles" : ""
    }`;
  const profileUrl = `${ctx.state.canonicalOrigin}/@${account.username}${
    articlesOnly ? "/articles" : ""
  }`;
  const avatarUrl = await getAvatarUrl(account);
  const posts = await db.query.postTable.findMany({
    with: {
      media: { orderBy: postMediumTable.index, limit: 1 },
    },
    where: and(
      eq(postTable.actorId, account.actor.id),
      isNull(postTable.sharedPostId),
      inArray(postTable.visibility, ["public", "unlisted"]),
      articlesOnly ? eq(postTable.type, "Article") : undefined,
    ),
    orderBy: desc(postTable.published),
    limit: WINDOW,
  });
  const feed = new Feed({
    id: canonicalUrl,
    link: profileUrl,
    title: account.name,
    description: account.actor.bioHtml == null
      ? undefined
      : stripHtml(account.actor.bioHtml),
    generator: "Hackers' Pub",
    image: avatarUrl,
    favicon: avatarUrl,
    updated: posts[0]?.updated ?? posts[0]?.published ?? account.updated,
    copyright: account.name,
    feedLinks: {
      atom: canonicalUrl,
    },
    author: {
      name: account.name,
      link: profileUrl,
    },
  });
  for (const post of posts) {
    feed.addItem({
      id: post.iri,
      link: post.url ?? post.iri,
      title: post.name ?? stripHtml(post.contentHtml),
      // FIXME: description: post.summaryHtml,
      content: post.contentHtml,
      author: [
        {
          name: account.name,
          link: profileUrl,
        },
      ],
      date: post.updated ?? post.published,
      published: post.published,
      image: post.media.length > 0
        ? {
          url: post.media[0].url,
          title: post.media[0].alt ?? undefined,
          type: post.media[0].type ?? undefined,
        }
        : undefined,
    });
  }
  return new Response(feed.atom1(), {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
    },
  });
});

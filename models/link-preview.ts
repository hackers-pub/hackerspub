import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { extractExternalLinks } from "./html.ts";
import { recomputeNewsScores } from "./news.ts";
import { postLinkTable, postTable } from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export interface RepairBrokenLinkPreviewsResult {
  readonly brokenLinks: number;
  readonly repairedPosts: number;
  readonly unresolvedPosts: number;
}

export interface RepairBrokenLinkPreviewsOptions {
  readonly linkIds?: readonly Uuid[];
}

function isBrokenResolvedUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (parsed == null) return false;
  return /\/(?:undefined|null)\/?$/i.test(parsed.pathname);
}

/**
 * Repairs previews previously grouped under a clearly broken publisher-
 * declared canonical URL, such as `https://www.youtube.com/undefined`.
 *
 * The backfill deliberately does not fetch remote pages.  It reuses the URL
 * embedded in each post, splits posts that were incorrectly collapsed into a
 * shared `post_link`, and copies the already-scraped preview metadata.  Normal
 * refreshes can later replace the authored URL with a redirect-verified
 * identity under the current scraper policy.
 */
export async function repairBrokenLinkPreviews(
  db: Database,
  options: RepairBrokenLinkPreviewsOptions = {},
): Promise<RepairBrokenLinkPreviewsResult> {
  const selectedLinks = options.linkIds == null
    ? await db.select().from(postLinkTable).where(
      sql`${postLinkTable.url} ~* '/(undefined|null)/?(\\?|$)'`,
    )
    : options.linkIds.length < 1
    ? []
    : await db.select().from(postLinkTable).where(
      inArray(postLinkTable.id, [...options.linkIds]),
    );
  const brokenLinks = selectedLinks.filter((link) =>
    isBrokenResolvedUrl(link.url)
  );
  if (brokenLinks.length < 1) {
    return { brokenLinks: 0, repairedPosts: 0, unresolvedPosts: 0 };
  }

  const brokenById = new Map(brokenLinks.map((link) => [link.id, link]));
  const posts = await db.query.postTable.findMany({
    where: {
      linkId: { in: brokenLinks.map((link) => link.id) },
      type: { in: ["Article", "Note", "Question"] },
      sharedPostId: { isNull: true },
    },
    with: {
      mentions: { with: { actor: true } },
      quotedPost: true,
    },
  });

  const affectedLinkIds = new Set<Uuid>(brokenLinks.map((link) => link.id));
  let repairedPosts = 0;
  let unresolvedPosts = 0;

  for (const post of posts) {
    if (post.linkId == null) continue;
    const brokenLink = brokenById.get(post.linkId);
    if (brokenLink == null) continue;

    // Public top-level articles use their own URL as the news link.  Only
    // articles that fell back to persistPostLink() can be reconstructed from
    // an external link embedded in their content.
    if (
      post.type === "Article" &&
      (post.visibility === "public" || post.visibility === "unlisted") &&
      post.replyTargetId == null &&
      post.quotedPostId == null
    ) {
      unresolvedPosts++;
      continue;
    }

    const excludeHrefs = new Set<string>();
    for (const mention of post.mentions) {
      excludeHrefs.add(mention.actor.iri);
      if (mention.actor.url != null) excludeHrefs.add(mention.actor.url);
      for (const alias of mention.actor.aliases) excludeHrefs.add(alias);
    }
    if (post.quotedPost != null) {
      excludeHrefs.add(post.quotedPost.iri);
      if (post.quotedPost.url != null) excludeHrefs.add(post.quotedPost.url);
    }

    const [sharedUrl] = extractExternalLinks(post.contentHtml, {
      excludeHrefs,
    });
    if (sharedUrl == null) {
      unresolvedPosts++;
      continue;
    }
    const resolvedUrl = new URL(sharedUrl);
    resolvedUrl.hash = "";
    if (isBrokenResolvedUrl(resolvedUrl.href)) {
      unresolvedPosts++;
      continue;
    }

    const [replacement] = await db.insert(postLinkTable).values({
      id: generateUuidV7(),
      url: resolvedUrl.href,
      title: brokenLink.title ?? undefined,
      siteName: brokenLink.siteName ?? undefined,
      type: brokenLink.type ?? undefined,
      description: brokenLink.description ?? undefined,
      author: brokenLink.author ?? undefined,
      imageUrl: brokenLink.imageUrl ?? undefined,
      imageAlt: brokenLink.imageAlt ?? undefined,
      imageType: brokenLink.imageType ?? undefined,
      imageWidth: brokenLink.imageWidth ?? undefined,
      imageHeight: brokenLink.imageHeight ?? undefined,
      creatorId: brokenLink.creatorId ?? undefined,
      scorePenalty: brokenLink.scorePenalty,
      created: brokenLink.created,
      scraped: brokenLink.scraped,
    }).onConflictDoUpdate({
      target: postLinkTable.url,
      set: {
        // A moderator penalty may exist on either URL identity.  Keep the
        // stronger one when the repaired URL already has a link row.
        scorePenalty:
          sql`greatest(${postLinkTable.scorePenalty}, excluded.score_penalty)`,
      },
    }).returning({
      id: postLinkTable.id,
    });
    const replacementId = replacement?.id;
    if (replacementId == null) {
      unresolvedPosts++;
      continue;
    }

    await db.update(postTable).set({
      linkId: replacementId,
      linkUrl: sharedUrl.href,
    }).where(eq(postTable.id, post.id));
    affectedLinkIds.add(replacementId);
    repairedPosts++;
  }

  await recomputeNewsScores(db, { linkIds: [...affectedLinkIds] });
  await db.delete(postLinkTable).where(sql`
    ${inArray(postLinkTable.id, brokenLinks.map((link) => link.id))}
    AND NOT EXISTS (
      SELECT 1 FROM ${postTable}
      WHERE ${postTable.linkId} = ${postLinkTable.id}
    )
  `);

  return { brokenLinks: brokenLinks.length, repairedPosts, unresolvedPosts };
}

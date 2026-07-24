import { getUserAgent } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { eq, inArray, sql } from "drizzle-orm";
import iconv from "iconv-lite";
import { Buffer } from "node:buffer";
import ogs from "open-graph-scraper";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { isSSRFSafeURL } from "ssrfcheck";
import { persistActorsByHandles } from "./actor.ts";
import type { ApplicationContext } from "./context.ts";
import type { Database } from "./db.ts";
import { extractExternalLinks } from "./html.ts";
import { recomputeNewsScores } from "./news.ts";
import {
  getRemoteFetchSignal,
  readResponseBytesAtMost,
} from "./post/remote-fetch.ts";
import {
  type NewPostLink,
  type PostLink,
  postLinkTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "link-preview"]);
const SCRAPE_IMAGE_METADATA_BYTES_LIMIT = 128 * 1024;
const MAX_REMOTE_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class UnsafeRemoteUrlError extends TypeError {}

function assertSafeRemoteUrl(url: URL): void {
  if (!isSSRFSafeURL(url.href, { autoPrependProtocol: false })) {
    throw new UnsafeRemoteUrlError(`Unsafe URL: ${url.href}`);
  }
}

async function fetchWithSafeRedirects(
  url: URL,
  init: Omit<RequestInit, "redirect">,
): Promise<Response> {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount++) {
    assertSafeRemoteUrl(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    const responseUrl =
      response.url === "" ? currentUrl : new URL(response.url);
    try {
      assertSafeRemoteUrl(responseUrl);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (location == null) return response;
    if (redirectCount >= MAX_REMOTE_REDIRECTS) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError(`Too many redirects from ${url.href}`);
    }
    await response.body?.cancel().catch(() => {});
    currentUrl = new URL(location, responseUrl);
  }
}

function clearPreviewImage(image: {
  imageUrl?: string;
  imageAlt?: string;
  imageType?: string;
  imageWidth?: number;
  imageHeight?: number;
}): void {
  image.imageUrl = undefined;
  image.imageAlt = undefined;
  image.imageType = undefined;
  image.imageWidth = undefined;
  image.imageHeight = undefined;
}

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
  const selectedLinks =
    options.linkIds == null
      ? await db
          .select()
          .from(postLinkTable)
          .where(sql`${postLinkTable.url} ~* '/(undefined|null)/?(\\?|$)'`)
      : options.linkIds.length < 1
        ? []
        : await db
            .select()
            .from(postLinkTable)
            .where(inArray(postLinkTable.id, [...options.linkIds]));
  const brokenLinks = selectedLinks.filter((link) =>
    isBrokenResolvedUrl(link.url),
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

    const [replacement] = await db
      .insert(postLinkTable)
      .values({
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
      })
      .onConflictDoUpdate({
        target: postLinkTable.url,
        set: {
          // A moderator penalty may exist on either URL identity.  Keep the
          // stronger one when the repaired URL already has a link row.
          scorePenalty: sql`greatest(${postLinkTable.scorePenalty}, excluded.score_penalty)`,
        },
      })
      .returning({
        id: postLinkTable.id,
      });
    const replacementId = replacement?.id;
    if (replacementId == null) {
      unresolvedPosts++;
      continue;
    }

    await db
      .update(postTable)
      .set({
        linkId: replacementId,
        linkUrl: sharedUrl.href,
      })
      .where(eq(postTable.id, post.id));
    affectedLinkIds.add(replacementId);
    repairedPosts++;
  }

  await recomputeNewsScores(db, { linkIds: [...affectedLinkIds] });
  await db.delete(postLinkTable).where(sql`
    ${inArray(
      postLinkTable.id,
      brokenLinks.map((link) => link.id),
    )}
    AND NOT EXISTS (
      SELECT 1 FROM ${postTable}
      WHERE ${postTable.linkId} = ${postLinkTable.id}
    )
  `);

  return { brokenLinks: brokenLinks.length, repairedPosts, unresolvedPosts };
}

export async function scrapePostLink(
  fedCtx: Pick<ApplicationContext, "canonicalOrigin">,
  url: string | URL,
  handleToActorId: (handle: string) => Promise<Uuid | undefined>,
  options: { signal?: AbortSignal } = {},
): Promise<NewPostLink | undefined> {
  const lg = logger.getChild("scrapePostLink");
  url = typeof url === "string" ? new URL(url) : url;
  if (!isSSRFSafeURL(url.href)) {
    lg.warn("Unsafe URL: {url}", { url: url.href });
    return undefined;
  }
  let response: Response;
  try {
    response = await fetchWithSafeRedirects(url, {
      headers: {
        "User-Agent": getUserAgent({
          software: "HackersPub",
          url: new URL(fedCtx.canonicalOrigin),
        }),
      },
      signal: getRemoteFetchSignal(options.signal),
    });
  } catch (error) {
    // Best-effort link-preview scrape: a remote being unreachable (DNS, TLS,
    // connection errors) is expected and not actionable, so log at `warn` to
    // keep it out of error tracking. The post still persists without a preview.
    lg.warn("Failed to fetch {url}: {error}", { url: url.href, error });
    return undefined;
  }
  const responseUrl =
    response.url == null || response.url === "" ? url.href : response.url;
  if (!response.ok) {
    // Best-effort: many sites refuse scrapers (403) or are briefly down (5xx).
    // Not actionable, so `warn` rather than `error`.
    lg.warn("Failed to scrape {url}: {status} {statusText}", {
      url: responseUrl,
      status: response.status,
      statusText: response.statusText,
    });
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const fullContentType = response.headers.get("Content-Type");
  const contentType = fullContentType?.replace(/\s*;.*$/, "");
  if (
    contentType === "application/pdf" ||
    contentType === "application/x-pdf"
  ) {
    try {
      const pdf = await PDFDocument.load(await response.arrayBuffer(), {
        updateMetadata: false,
      });
      return {
        id: generateUuidV7(),
        url: responseUrl,
        title: pdf.getTitle(),
        description: pdf.getSubject(),
        author: pdf.getAuthor(),
      };
    } catch (error) {
      lg.warn("Failed to read or parse PDF from {url}: {error}", {
        url: responseUrl,
        error,
      });
      return undefined;
    }
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    lg.warn("Not an HTML page: {url} ({contentType})", {
      url: responseUrl,
      contentType,
    });
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const contentTypeParams = Object.fromEntries(
    (fullContentType?.replace(/^[^;]*;\s*/, "")?.split(/\s*;\s*/g) ?? [])
      .map((pair: string) => pair.split(/\s*=\s*/))
      .filter((pair) => pair.length === 2)
      .map((pair) => pair as [string, string]),
  );
  let charset = contentTypeParams.charset
    ?.replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    lg.warn("Failed to read body from {url}: {error}", {
      url: responseUrl,
      error,
    });
    return undefined;
  }
  if (!charset) {
    // Try to find charset in meta tags if not specified in Content-Type
    const decoder = new TextDecoder();
    const rawHtml = decoder.decode(bytes);
    const charsetMatch = rawHtml.match(/<meta\s+.*?charset=["']?([\w-]+)/i);
    if (charsetMatch != null) charset = charsetMatch[1].toLowerCase();
  }

  let html: string;
  try {
    html =
      !charset || charset === "utf-8" || charset === "utf8"
        ? new TextDecoder().decode(bytes)
        : iconv.decode(Buffer.from(bytes), charset);
  } catch (error) {
    lg.warn("Failed to decode HTML from {url}: {error}", {
      url: responseUrl,
      error,
      charset,
    });
    return undefined;
  }
  if (html.trim().length < 1) {
    lg.warn("Empty HTML page: {url}", { url: responseUrl });
    return undefined;
  }
  let result: Awaited<ReturnType<typeof ogs>>["result"];
  try {
    const scraped = await ogs({
      html,
      customMetaTags: [
        {
          multiple: false,
          property: "fediverse:creator",
          fieldName: "fediverseCreator",
        },
      ],
    });
    if (scraped.error) {
      // Best-effort: the page loaded but Open Graph parsing failed. Not
      // actionable, so `warn` rather than `error`.
      lg.warn("Failed to scrape {url}: {error}", {
        url: responseUrl,
        result: scraped.result,
      });
      return undefined;
    }
    result = scraped.result;
  } catch (error) {
    // `open-graph-scraper` throws plain objects for parser setup failures.
    // Link previews are best-effort, so do not fail ActivityPub ingestion.
    lg.warn("Failed to scrape {url}: {error}", { url: responseUrl, error });
    return undefined;
  }
  lg.debug("Scraped {url}: {result}", { url: responseUrl, result });
  const ogImage = result.ogImage ?? [];
  const twitterImage = result.twitterImage ?? [];
  const image: {
    imageUrl?: string;
    imageAlt?: string;
    imageType?: string;
    imageWidth?: number;
    imageHeight?: number;
  } =
    ogImage.length > 0
      ? {
          imageUrl: ogImage[0].url,
          imageAlt: ogImage[0].alt,
          imageType:
            ogImage[0].type === "png"
              ? "image/png"
              : ogImage[0].type === "jpg" || ogImage[0].type === "jpeg"
                ? "image/jpeg"
                : ogImage[0].type == null ||
                    !ogImage[0].type.startsWith("image/")
                  ? undefined
                  : ogImage[0].type,
          imageWidth:
            typeof ogImage[0].width === "string"
              ? parseInt(ogImage[0].width)
              : ogImage[0].width,
          imageHeight:
            typeof ogImage[0].height === "string"
              ? parseInt(ogImage[0].height)
              : ogImage[0].height,
        }
      : twitterImage.length > 0
        ? {
            imageUrl: twitterImage[0].url,
            imageAlt: twitterImage[0].alt,
            imageWidth:
              typeof twitterImage[0].width === "string"
                ? parseInt(twitterImage[0].width)
                : twitterImage[0].width,
            imageHeight:
              typeof twitterImage[0].height === "string"
                ? parseInt(twitterImage[0].height)
                : twitterImage[0].height,
          }
        : {};
  if (image.imageUrl != null) {
    try {
      const imageUrl = new URL(image.imageUrl, responseUrl);
      assertSafeRemoteUrl(imageUrl);
      image.imageUrl = imageUrl.href;
    } catch (error) {
      lg.warn("Ignoring invalid preview image URL for {url}: {error}", {
        url: responseUrl,
        imageUrl: image.imageUrl,
        error,
      });
      clearPreviewImage(image);
    }
  }
  if (
    image.imageUrl != null &&
    (image.imageWidth == null || image.imageHeight == null)
  ) {
    try {
      const response = await fetchWithSafeRedirects(new URL(image.imageUrl), {
        headers: {
          "User-Agent": getUserAgent({
            software: "HackersPub",
            url: new URL(fedCtx.canonicalOrigin),
          }),
          Accept: "image/*",
          Range: `bytes=0-${SCRAPE_IMAGE_METADATA_BYTES_LIMIT - 1}`,
          Referer: responseUrl,
        },
        signal: getRemoteFetchSignal(options.signal),
      });
      logger.debug("Fetched image {url}: {status} {statusText}", {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
      });
      if (response.ok) {
        const body = await readResponseBytesAtMost(
          response,
          SCRAPE_IMAGE_METADATA_BYTES_LIMIT,
        );
        try {
          const metadata = await sharp(body).metadata();
          switch (metadata.orientation) {
            case 6:
            case 8:
              image.imageWidth = metadata.height;
              image.imageHeight = metadata.width;
              break;
            case 1:
            case 3:
            default:
              image.imageWidth = metadata.width;
              image.imageHeight = metadata.height;
              break;
          }
        } catch {
          image.imageWidth = undefined;
          image.imageHeight = undefined;
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      logger.debug("Failed to fetch image {url}: {error}", {
        url: image.imageUrl,
        error,
      });
      if (error instanceof UnsafeRemoteUrlError) {
        clearPreviewImage(image);
      } else {
        image.imageWidth = undefined;
        image.imageHeight = undefined;
      }
    }
  }
  const creatorHandle =
    result.customMetaTags?.fediverseCreator == null
      ? undefined
      : Array.isArray(result.customMetaTags.fediverseCreator)
        ? result.customMetaTags.fediverseCreator[0]
        : result.customMetaTags.fediverseCreator;
  const declaredCanonicalUrl =
    result.ogUrl ?? result.twitterUrl ?? result.requestUrl;
  if (declaredCanonicalUrl != null) {
    lg.debug("Ignoring declared canonical URL for {url}: {canonicalUrl}", {
      url: responseUrl,
      canonicalUrl: declaredCanonicalUrl,
    });
  }
  return {
    id: generateUuidV7(),
    // response.url is the strongest identity we can verify: unlike Open Graph
    // or rel=canonical metadata, it is the URL reached by an actual redirect
    // chain.  Fragments never reach HTTP and are preserved separately on Post.
    url: responseUrl,
    title: result.ogTitle ?? result.twitterTitle,
    siteName: result.ogSiteName,
    type: result.ogType,
    description: result.ogDescription ?? result.twitterDescription,
    author: result.ogArticleAuthor,
    creatorId:
      creatorHandle == null || handleToActorId == null
        ? undefined
        : await handleToActorId(creatorHandle),
    ...image,
  };
}

const POST_LINK_CACHE_TTL = Temporal.Duration.from({ hours: 24 });

export async function persistPostLink(
  ctx: ApplicationContext,
  url: string | URL,
  options: { signal?: AbortSignal } = {},
): Promise<PostLink | undefined> {
  if (typeof url === "string") url = new URL(url);
  if (!isSSRFSafeURL(url.href)) {
    logger.warn("Unsafe URL: {url}", { url: url.href });
    return undefined;
  }
  const scrapeUrl = new URL(url);
  scrapeUrl.hash = "";
  const { db } = ctx;
  let link = await db.query.postLinkTable.findFirst({
    where: { url: scrapeUrl.href },
  });
  if (link == null) {
    const priorPost = await db.query.postTable.findFirst({
      columns: { linkId: true },
      where: { linkUrl: url.href },
      orderBy: { updated: "desc" },
    });
    if (priorPost?.linkId != null) {
      link = await db.query.postLinkTable.findFirst({
        where: { id: priorPost.linkId },
      });
    }
  }
  if (link != null) {
    const scraped = link.scraped.toTemporalInstant();
    if (
      Temporal.Instant.compare(
        scraped.add(POST_LINK_CACHE_TTL),
        Temporal.Now.instant(),
      ) > 0
    ) {
      logger.debug("Post link cache hit: {url}", { url: scrapeUrl.href });
      return link;
    }
  }
  let scrapedLink = await scrapePostLink(
    ctx,
    scrapeUrl,
    async (handle) => {
      if (!handle.startsWith("@")) handle = `@${handle}`;
      const actors = await persistActorsByHandles(ctx, [handle]);
      return actors[handle]?.id;
    },
    {
      signal: options.signal,
    },
  );
  logger.debug("Scraped link {url}: {link}", {
    url: url.href,
    link: scrapedLink,
  });
  if (scrapedLink == null) return undefined;
  if (scrapedLink.imageWidth == null || scrapedLink.imageHeight == null) {
    scrapedLink = {
      ...scrapedLink,
      imageWidth: undefined,
      imageHeight: undefined,
    };
  }
  const result = await db
    .insert(postLinkTable)
    .values(scrapedLink)
    .onConflictDoUpdate({
      target: postLinkTable.url,
      set: {
        title: scrapedLink.title,
        siteName: scrapedLink.siteName,
        type: scrapedLink.type,
        description: scrapedLink.description,
        imageUrl: scrapedLink.imageUrl,
        imageAlt: scrapedLink.imageAlt,
        imageType: scrapedLink.imageType,
        imageWidth: scrapedLink.imageWidth,
        imageHeight: scrapedLink.imageHeight,
        creatorId: scrapedLink.creatorId,
        scraped: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: eq(postLinkTable.url, scrapedLink.url),
    })
    .returning();
  return result[0];
}

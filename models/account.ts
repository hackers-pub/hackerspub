import {
  getActorHandle,
  getNodeInfo,
  isActor,
  lookupObject,
  PropertyValue,
  type RequestContext,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { zip } from "@std/collections/zip";
import { encodeHex } from "@std/encoding/hex";
import { escape } from "@std/html/entities";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import { compactUrl } from "../utils.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type AccountLinkIcon,
  accountLinkTable,
  accountTable,
  type NewAccount,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "account"]);

export async function getAvatarUrl(
  account: Account & { emails: AccountEmail[] },
): Promise<string> {
  const emails = account.emails
    .filter((e) => e.verified != null);
  emails.sort((a, b) => a.public ? 1 : b.public ? -1 : 0);
  const textEncoder = new TextEncoder();
  let url = "mp";
  for (const email of emails) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(email.email.toLowerCase()),
    );
    url = `https://gravatar.com/avatar/${encodeHex(hash)}?r=pg&s=128&d=${
      encodeURIComponent(url)
    }`;
  }
  return url == "mp" ? "https://gravatar.com/avatar/?d=mp&s=128" : url;
}

export async function updateAccount(
  db: Database,
  fedCtx: RequestContext<void>,
  account: NewAccount & { links: Link[] },
): Promise<Account & { links: AccountLink[] } | undefined> {
  const result = await updateAccountData(db, account);
  if (result == null) return undefined;
  const links = await updateAccountLinks(
    db,
    result.id,
    new URL(`/@${account.username}`, fedCtx.origin).href,
    account.links,
  );
  await fedCtx.sendActivity(
    { identifier: result.id },
    "followers",
    new vocab.Update({
      id: new URL(
        `#update/${result.updated.toISOString()}`,
        fedCtx.getActorUri(result.id),
      ),
      actor: fedCtx.getActorUri(result.id),
      to: vocab.PUBLIC_COLLECTION,
      object: await fedCtx.getActor(result.id),
    }),
    {
      preferSharedInbox: true,
      excludeBaseUris: [fedCtx.url],
    },
  );
  return { ...result, links };
}

export async function updateAccountData(
  db: Database,
  account: NewAccount,
): Promise<Account | undefined> {
  const values: Omit<NewAccount, "id"> = { ...account };
  if ("id" in values) delete values.id;
  const result = await db.update(accountTable).set({
    ...values,
    username: sql`
      CASE
        WHEN ${accountTable.usernameChanged} IS NULL
        THEN ${values.username}
        ELSE ${accountTable.username}
      END
    `,
    usernameChanged: sql`
        CASE
          WHEN
            ${accountTable.username} = ${values.username} OR
            ${accountTable.usernameChanged} IS NOT NULL
          THEN ${accountTable.usernameChanged}
          ELSE CURRENT_TIMESTAMP
        END
      `,
    updated: sql`CURRENT_TIMESTAMP`,
  }).where(eq(accountTable.id, account.id)).returning();
  return result.length > 0 ? result[0] : undefined;
}

export interface Link {
  name: string;
  url: string | URL;
}

export async function updateAccountLinks(
  db: Database,
  accountId: Uuid,
  verifyUrl: URL | string,
  links: Link[],
): Promise<AccountLink[]> {
  logger.debug(
    "Updating account links for {accountId}: {links}",
    { accountId, links },
  );
  const existing = await db.query.accountLinkTable.findMany({
    where: eq(accountLinkTable.accountId, accountId),
  });
  const existingMap = Object.fromEntries(
    existing.map((link) => [link.url, link]),
  );
  const now = Temporal.Now.instant();
  const [metadata, verifies] = await Promise.all([
    Promise.all(
      links.map((link) =>
        existingMap[link.url.toString()] ??
          fetchAccountLinkMetadata(link.url)
      ),
    ),
    // TODO: Forget and fire:
    Promise.all(
      links.map((link) => {
        const existing = existingMap[link.url.toString()];
        return existing?.verified == null ||
            existing.verified.toTemporalInstant().until(now).total("days") > 7
          ? verifyAccountLink(link.url, verifyUrl)
          : existing.verified;
      }),
    ),
  ]);
  const data = zip(links, metadata, verifies).map(([link, meta, verified]) => ({
    ...meta,
    name: link.name,
    verified,
  }));
  await db.delete(accountLinkTable)
    .where(eq(accountLinkTable.accountId, accountId));
  if (data.length < 1) return [];
  return await db.insert(accountLinkTable).values(
    data.map((link, index) => ({
      accountId,
      index,
      name: link.name,
      url: link.url.toString(),
      handle: link.handle,
      icon: link.icon,
      verified: link.verified instanceof Date
        ? link.verified
        : link.verified
        ? sql`CURRENT_TIMESTAMP`
        : null,
      created: link.created ?? sql`CURRENT_TIMESTAMP`,
    })),
  ).returning();
}

const LINK_PATTERN = /<(?:a|link)\s+([^>])>/g;
const LINK_ATTRIBUTE_PATTERN = /(\w+)=(?:"([^"]*)"|'([^']*)'|[^\s>]+)\b/g;

export async function verifyAccountLink(
  url: string | URL,
  verifyUrl: string | URL,
): Promise<boolean> {
  logger.debug("Verifying account link {url}...", { url: url.toString() });
  const response = await fetch(url);
  if (!response.ok) return false;
  const text = await response.text();
  for (const match of text.matchAll(LINK_PATTERN)) {
    const attributes: Record<string, string> = {};
    for (const attrMatch of match[1].matchAll(LINK_ATTRIBUTE_PATTERN)) {
      attributes[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ??
        attrMatch[4];
    }
    if (attributes.rel?.toLowerCase() !== "me") continue;
    if (attributes.href === verifyUrl.toString()) return true;
  }
  return false;
}

export interface LinkMetadata {
  icon: AccountLinkIcon;
  handle?: string;
}

export async function fetchAccountLinkMetadata(
  url: string | URL,
): Promise<LinkMetadata> {
  url = new URL(url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { icon: "web" };
  }
  let host = url.host;
  if (host.startsWith("www.")) host = host.substring(4);
  if (host === "bsky.app" || url.host === "staging.bsky.app") {
    const m = url.pathname.match(/^\/+profile\/+([^/]+)\/*$/);
    if (m != null) {
      return {
        icon: "bluesky",
        handle: m[1].startsWith("did:") ? m[1] : `@${m[1]}`,
      };
    }
  } else if (host === "codeberg.org") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "codeberg", handle: `@${m[1]}` };
  } else if (host === "dev.to") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "dev", handle: `@${m[1]}` };
  } else if (host === "discord.com" || host === "discordapp.com") {
    const m = url.pathname.match(/^\/+users\/+([^/]+)\/*$/);
    if (m != null) return { icon: "discord" };
  } else if (
    host === "facebook.com" || url.host === "web.facebook.com" ||
    url.host === "m.facebook.com"
  ) {
    if (
      url.pathname.startsWith("/people/") || url.pathname === "/profile.php"
    ) {
      return { icon: "facebook" };
    }
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "facebook", handle: m[1] };
  } else if (host === "github.com") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "github", handle: `@${m[1]}` };
  } else if (host === "gitlab.com") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "gitlab", handle: `@${m[1]}` };
  } else if (
    url.host === "news.ycombinator.com" && url.pathname === "/user" &&
    url.searchParams.has("id")
  ) {
    return {
      icon: "hackernews",
      handle: url.searchParams.get("id") ?? undefined,
    };
  } else if (host === "instagram.com") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "instagram", handle: `@${m[1]}` };
  } else if (host === "keybase.io") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "keybase", handle: m[1] };
  } else if (host === "linkedin.com" && url.pathname.startsWith("/in/")) {
    const m = url.pathname.match(/^\/+in\/+([^/]+)\/*/);
    if (m != null) return { icon: "linkedin", handle: m[1] };
  } else if (host === "lobste.rs" && url.pathname.startsWith("/~")) {
    const m = url.pathname.match(/^\/+(~[^/]+)\/*/);
    if (m != null) return { icon: "lobsters", handle: m[1] };
  } else if (
    host === "matrix.to" && url.pathname === "/" && url.hash.startsWith("#/")
  ) {
    return { icon: "matrix", handle: url.hash.substring(2) };
  } else if (host === "qiita.com") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "qiita", handle: `@${m[1]}` };
  } else if (host === "reddit.com" || url.host === "old.reddit.com") {
    const m = url.pathname.match(/^\/+r\/+([^/]+)\/*/);
    if (m != null) return { icon: "reddit", handle: `/r/${m[1]}` };
    const m2 = url.pathname.match(/^\/+u(?:ser)?\/+([^/]+)\/*/);
    if (m2 != null) return { icon: "reddit", handle: `/u/${m2[1]}` };
  } else if (
    (url.host === "sr.ht" || url.host === "git.sr.ht" ||
      url.host === "hg.sr.ht") && url.pathname.startsWith("/~")
  ) {
    return {
      icon: "sourcehut",
      handle: url.pathname.substring(1).replace(/\/+$/, ""),
    };
  } else if (host === "threads.net") {
    const m = url.pathname.match(/^\/+(@[^/]+)\/*/);
    if (m != null) return { icon: "threads", handle: m[1] };
  } else if (host === "velog.io") {
    const m = url.pathname.match(/^\/+(@[^/]+)(?:\/*(?:posts\/*)?)?/);
    if (m != null) return { icon: "velog", handle: m[1] };
  } else if (
    url.host.endsWith(".wikipedia.org") && url.pathname.startsWith("/wiki/")
  ) {
    logger.debug("Fetching metadata for {url}...", { url: url.href });
    const title = decodeURIComponent(url.pathname.substring(6));
    const apiUrl = new URL("/w/api.php", url);
    apiUrl.searchParams.set("action", "query");
    apiUrl.searchParams.set("prop", "info");
    apiUrl.searchParams.set("inprop", "displaytitle");
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("titles", title);
    const response = await fetch(apiUrl);
    if (!response.ok) return { icon: "wikipedia" };
    const result = await response.json();
    const pages = Object.values(result.query.pages);
    if (pages.length < 1) return { icon: "wikipedia" };
    const page = pages[0] as { pageid?: number; displaytitle: string };
    if (page.pageid == null) return { icon: "wikipedia" };
    return { icon: "wikipedia", handle: page.displaytitle };
  } else if (host === "x.com" || host === "twitter.com") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "x", handle: `@${m[1]}` };
  } else if (host === "zenn.dev") {
    const m = url.pathname.match(/^\/+([^/]+)\/*/);
    if (m != null) return { icon: "zenn", handle: `@${m[1]}` };
  }
  logger.debug("Fetching metadata for {url}...", { url: url.href });
  const nodeInfo = await getNodeInfo(url, { parse: "best-effort" });
  if (nodeInfo?.protocols.includes("activitypub")) {
    const object = await lookupObject(url);
    if (isActor(object)) {
      const handle = await getActorHandle(object);
      if (handle != null) {
        const sw = nodeInfo.software.name;
        return {
          icon: sw === "hollo" || sw === "lemmy" || sw === "mastodon" ||
              sw === "misskey" || sw === "pixelfed" || sw === "pleroma"
            ? sw
            : "activitypub",
          handle,
        };
      }
    }
    return { icon: "activitypub" };
  }
  return { icon: "web" };
}

export function renderAccountLinks(links: AccountLink[]): PropertyValue[] {
  return links.map((link) =>
    new PropertyValue({
      name: link.name,
      value: `<a href="${escape(link.url)}" rel="me" translate="no">${
        escape(link.handle ?? compactUrl(link.url))
      }</a>`,
    })
  );
}

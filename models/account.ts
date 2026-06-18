import { getNodeInfo, type RequestContext } from "@fedify/fedify";
import {
  getActorHandle,
  isActor,
  lookupObject,
  PropertyValue,
} from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { zip } from "@std/collections/zip";
import { encodeHex } from "@std/encoding/hex";
import { escape, unescape } from "@std/html/entities";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import sharp from "sharp";
import type { ContextData } from "./context.ts";
import type { Database } from "./db.ts";
import { updateFolloweesCount, updateFollowersCount } from "./following.ts";
import {
  createMediumFromBlob,
  createMediumFromBytes,
  createMediumFromUrl,
} from "./medium.ts";
import { articleBoostLinkIds, refreshNewsScores } from "./news.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type AccountLinkIcon,
  accountLinkTable,
  accountTable,
  type Actor,
  actorTable,
  articleContentTable,
  deletedAccountKeyTable,
  deletedAccountTable,
  type Medium,
  type NewAccount,
  notificationTable,
  pollOptionTable,
  pollTable,
  pollVoteTable,
  postTable,
  reactionTable,
} from "./schema.ts";
import { removeFromTimeline } from "./timeline.ts";
import { compactUrl } from "./url.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "account"]);

export class AccountDeletionUnavailableError extends Error {
  public constructor() {
    super("Account deletion is unavailable for this account.");
  }
}

export interface DeletedAccountResult {
  accountId: Uuid;
  username: string;
  deleted: Date;
}

async function collectNewsLinkIdsForPosts(
  db: Database,
  posts: ReadonlyArray<{
    readonly linkId: Uuid | null;
    readonly sharedPostId?: Uuid | null;
  }>,
): Promise<Uuid[]> {
  const linkIds = new Set(
    posts.map((post) => post.linkId).filter((id): id is Uuid => id != null),
  );
  for (
    const linkId of await articleBoostLinkIds(
      db,
      posts.map((post) => post.sharedPostId),
    )
  ) {
    linkIds.add(linkId);
  }
  return [...linkIds];
}

export async function isUsernameReserved(
  db: Database,
  username: string,
): Promise<boolean> {
  const canonicalUsername = username.trim().toLowerCase();
  const deleted = await db.query.deletedAccountTable.findFirst({
    where: { username: canonicalUsername },
    columns: { accountId: true },
  });
  return deleted != null;
}

async function hasModerationAuditLinks(
  db: Database,
  accountId: Uuid,
  actorId: Uuid,
): Promise<boolean> {
  const flagCase = await db.query.flagCaseTable.findFirst({
    where: {
      OR: [
        { targetActorId: actorId },
        { assignedModeratorId: accountId },
      ],
    },
    columns: { id: true },
  });
  if (flagCase != null) return true;

  const flag = await db.query.flagTable.findFirst({
    where: {
      OR: [
        { reporterId: actorId },
        { targetActorId: actorId },
      ],
    },
    columns: { id: true },
  });
  if (flag != null) return true;

  const flagAction = await db.query.flagActionTable.findFirst({
    where: { moderatorId: accountId },
    columns: { id: true },
  });
  if (flagAction != null) return true;

  const flagAppeal = await db.query.flagAppealTable.findFirst({
    where: {
      OR: [
        { appellantId: accountId },
        { reviewerId: accountId },
      ],
    },
    columns: { id: true },
  });
  return flagAppeal != null;
}

async function recomputePostInteractionCounts(
  db: Database,
  postIds: Uuid[],
): Promise<void> {
  const ids = [...new Set(postIds)];
  if (ids.length < 1) return;
  await db.update(postTable)
    .set({
      repliesCount: sql<number>`
        (
          SELECT COUNT(*)::int
          FROM ${postTable} AS child
          WHERE child.reply_target_id = ${postTable.id}
        )
      `,
      sharesCount: sql<number>`
        (
          SELECT COUNT(*)::int
          FROM ${postTable} AS child
          WHERE child.shared_post_id = ${postTable.id}
        )
      `,
      quotesCount: sql<number>`
        (
          SELECT COUNT(*)::int
          FROM ${postTable} AS child
          WHERE child.quoted_post_id = ${postTable.id}
        )
      `,
    })
    .where(inArray(postTable.id, ids));
}

async function recomputePostReactionCounts(
  db: Database,
  postIds: Uuid[],
): Promise<void> {
  const ids = [...new Set(postIds)];
  if (ids.length < 1) return;
  await db.update(postTable)
    .set({
      reactionsCounts: sql`
        (
          SELECT coalesce(jsonb_object_agg(stats.emoji, stats.count), '{}')
          FROM (
            SELECT
              coalesce(
                ${reactionTable.emoji},
                ${reactionTable.customEmojiId}::text
              ),
              count(*)
            FROM ${reactionTable}
            WHERE ${reactionTable.postId} = ${postTable.id}
            GROUP BY coalesce(
              ${reactionTable.emoji},
              ${reactionTable.customEmojiId}::text
            )
          ) AS stats(emoji, count)
        )
      `,
    })
    .where(inArray(postTable.id, ids));
}

async function recomputePollVoteCounts(
  db: Database,
  postIds: Uuid[],
): Promise<void> {
  const ids = [...new Set(postIds)];
  if (ids.length < 1) return;
  await db.update(pollTable)
    .set({
      votersCount: sql<number>`
        (
          SELECT COUNT(DISTINCT ${pollVoteTable.actorId})::int
          FROM ${pollVoteTable}
          WHERE ${pollVoteTable.postId} = ${pollTable.postId}
        )
      `,
    })
    .where(inArray(pollTable.postId, ids));
  await db.update(pollOptionTable)
    .set({
      votesCount: sql<number>`
        (
          SELECT COUNT(*)::int
          FROM ${pollVoteTable}
          WHERE ${pollVoteTable.postId} = ${pollOptionTable.postId}
            AND ${pollVoteTable.optionIndex} = ${pollOptionTable.index}
        )
      `,
    })
    .where(inArray(pollOptionTable.postId, ids));
}

async function removeActorFromNotifications(
  db: Database,
  actorId: Uuid,
): Promise<void> {
  const updated = await db.update(notificationTable)
    .set({
      actorIds: sql`array_remove(${notificationTable.actorIds}, ${actorId})`,
    })
    .where(sql`${actorId} = ANY(${notificationTable.actorIds})`)
    .returning({ id: notificationTable.id });
  const updatedIds = updated.map((notification) => notification.id);
  if (updatedIds.length < 1) return;
  await db.delete(notificationTable)
    .where(
      and(
        inArray(notificationTable.id, updatedIds),
        isNotificationActorIdsEmpty(),
      ),
    );
}

function isNotificationActorIdsEmpty() {
  return sql`array_length(${notificationTable.actorIds}, 1) IS NULL`;
}

function toDeletedAccountRecipient(actor: Actor): vocab.Recipient {
  return {
    id: new URL(actor.iri),
    inboxId: new URL(actor.inboxUrl),
    endpoints: actor.sharedInboxUrl == null ? null : {
      sharedInbox: new URL(actor.sharedInboxUrl),
    },
  };
}

async function ensureAccountKeys(
  fedCtx: RequestContext<ContextData>,
  accountId: Uuid,
): Promise<void> {
  const context = fedCtx as RequestContext<ContextData> & {
    getActorKeyPairs?: (identifier: string) => Promise<unknown>;
  };
  if (typeof context.getActorKeyPairs !== "function") return;
  await context.getActorKeyPairs(accountId);
}

export async function deleteAccount(
  fedCtx: RequestContext<ContextData>,
  accountId: Uuid,
): Promise<DeletedAccountResult | undefined> {
  const { db } = fedCtx.data;
  const accountForKeys = await db.query.accountTable.findFirst({
    where: { id: accountId },
    with: { actor: true },
  });
  if (accountForKeys == null) return undefined;
  if (
    await hasModerationAuditLinks(
      db,
      accountForKeys.id,
      accountForKeys.actor.id,
    )
  ) {
    throw new AccountDeletionUnavailableError();
  }
  await ensureAccountKeys(fedCtx, accountForKeys.id);

  const deleted = new Date();
  let result: DeletedAccountResult | undefined;
  let deleteRecipients: vocab.Recipient[] = [];

  await db.transaction(async (tx) => {
    const [locked] = await tx.select({
      account: accountTable,
      actor: actorTable,
    })
      .from(accountTable)
      .innerJoin(actorTable, eq(actorTable.accountId, accountTable.id))
      .where(eq(accountTable.id, accountId))
      .for("update");
    if (locked == null) return;

    const { account, actor } = locked;
    if (await hasModerationAuditLinks(tx, account.id, actor.id)) {
      throw new AccountDeletionUnavailableError();
    }

    const affectedPosts = await tx.query.postTable.findMany({
      where: { actorId: actor.id },
      columns: {
        id: true,
        actorId: true,
        linkId: true,
        replyTargetId: true,
        sharedPostId: true,
        quotedPostId: true,
      },
    });
    const deletionRelationshipRows = await tx.query.followingTable.findMany({
      with: { followee: true, follower: true },
      where: {
        accepted: { isNotNull: true },
        OR: [
          { followerId: actor.id },
          { followeeId: actor.id },
        ],
      },
    });
    const deletionRecipientMap = new Map<string, vocab.Recipient>();
    for (const following of deletionRelationshipRows) {
      const recipientActor = following.followerId === actor.id
        ? following.followee
        : following.follower;
      if (recipientActor.id === actor.id) continue;
      const recipient = toDeletedAccountRecipient(recipientActor);
      deletionRecipientMap.set(recipientActor.iri, recipient);
    }
    deleteRecipients = [...deletionRecipientMap.values()];
    const affectedReactionPosts = await tx.select({
      id: postTable.id,
      linkId: postTable.linkId,
      sharedPostId: postTable.sharedPostId,
    })
      .from(reactionTable)
      .innerJoin(postTable, eq(postTable.id, reactionTable.postId))
      .where(eq(reactionTable.actorId, actor.id));
    const affectedPollVotePosts = await tx.select({
      postId: pollVoteTable.postId,
    })
      .from(pollVoteTable)
      .where(eq(pollVoteTable.actorId, actor.id));
    const parentIds = [
      ...new Set(
        affectedPosts.flatMap((post) => [
          post.replyTargetId,
          post.sharedPostId,
          post.quotedPostId,
        ]).filter((id): id is Uuid => id != null),
      ),
    ];

    const parentPosts = parentIds.length < 1
      ? []
      : await tx.query.postTable.findMany({
        where: { id: { in: parentIds } },
        columns: { id: true, linkId: true, sharedPostId: true },
      });
    const affectedLinkIds = await collectNewsLinkIdsForPosts(tx, [
      ...affectedPosts,
      ...parentPosts,
      ...affectedReactionPosts,
    ]);

    const actorUri = fedCtx.getActorUri(account.id);
    const accountKeys = await tx.query.accountKeyTable.findMany({
      where: { accountId: account.id },
    });
    await tx.insert(deletedAccountTable).values({
      accountId: account.id,
      username: account.username,
      actorIri: actorUri.href,
      deleted,
    });
    if (accountKeys.length > 0) {
      await tx.insert(deletedAccountKeyTable).values(
        accountKeys.map((key) => ({
          accountId: key.accountId,
          type: key.type,
          public: key.public,
          private: key.private,
          created: key.created,
        })),
      );
    }
    for (const post of affectedPosts) {
      if (post.sharedPostId != null) {
        await removeFromTimeline(tx, post);
      }
    }
    await tx.delete(articleContentTable)
      .where(
        or(
          eq(articleContentTable.translatorId, account.id),
          eq(articleContentTable.translationRequesterId, account.id),
        ),
      );
    await tx.delete(accountTable).where(eq(accountTable.id, account.id));
    for (const following of deletionRelationshipRows) {
      if (following.followerId === actor.id) {
        await updateFollowersCount(tx, following.followeeId, -1);
      }
      if (following.followeeId === actor.id) {
        await updateFolloweesCount(tx, following.followerId, -1);
      }
    }
    await removeActorFromNotifications(tx, actor.id);
    await recomputePostInteractionCounts(tx, parentIds);
    await recomputePostReactionCounts(
      tx,
      affectedReactionPosts.map((post) => post.id),
    );
    await recomputePollVoteCounts(
      tx,
      affectedPollVotePosts.map((post) => post.postId),
    );
    await refreshNewsScores(tx, affectedLinkIds);
    result = { accountId: account.id, username: account.username, deleted };
  });

  if (result == null) return undefined;
  const actorUri = fedCtx.getActorUri(result.accountId);
  try {
    await fedCtx.sendActivity(
      { identifier: result.accountId },
      deleteRecipients,
      new vocab.Delete({
        id: new URL(`#delete/${deleted.toISOString()}`, actorUri),
        actor: actorUri,
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Tombstone({
          id: actorUri,
          formerType: vocab.Person,
          deleted: Temporal.Instant.fromEpochMilliseconds(deleted.getTime()),
        }),
      }),
      {
        orderingKey: actorUri.href,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  } catch (error) {
    logger.error(
      "Failed to enqueue actor Delete for deleted account {accountId}: {error}",
      { accountId: result.accountId, error },
    );
  }
  return result;
}

export async function getAvatarUrl(
  disk: Disk,
  account: Account & {
    emails: AccountEmail[];
    avatarMedium?: Medium | null;
  },
): Promise<string> {
  if (account.avatarMedium != null) {
    return await disk.getUrl(account.avatarMedium.key);
  }
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

async function preprocessAvatarMedium(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { buffer, format } = await transformAvatar(bytes);
  return {
    bytes: buffer,
    contentType: `image/${format}`,
  };
}

export async function createAvatarMediumFromBlob(
  db: Database,
  disk: Disk,
  blob: Blob,
  options: { maxSize?: number } = {},
): Promise<Medium | undefined> {
  return await createMediumFromBlob(db, disk, blob, {
    ...options,
    preprocess: preprocessAvatarMedium,
  });
}

export async function createAvatarMediumFromUrl(
  db: Database,
  disk: Disk,
  url: URL,
  options: { maxSize?: number; userAgentUrl?: URL } = {},
): Promise<Medium | undefined> {
  return await createMediumFromUrl(db, disk, url, {
    ...options,
    preprocess: preprocessAvatarMedium,
  });
}

export async function createAvatarMediumFromMedium(
  db: Database,
  disk: Disk,
  medium: Medium,
  options: { maxSize?: number } = {},
): Promise<Medium | undefined> {
  const bytes = await disk.getBytes(medium.key);
  return await createMediumFromBytes(db, disk, bytes, {
    ...options,
    contentType: medium.type,
    preprocess: preprocessAvatarMedium,
  });
}

export async function getAccountByUsername(
  db: Database,
  username: string,
): Promise<
  | Account & {
    actor: Actor & { successor: Actor | null };
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  }
  | undefined
> {
  const account = await db.query.accountTable.findFirst({
    with: {
      actor: { with: { successor: true } },
      avatarMedium: true,
      emails: true,
      links: { orderBy: { index: "asc" } },
    },
    where: { username },
  });
  if (account != null) return account;
  return await db.query.accountTable.findFirst({
    with: {
      actor: { with: { successor: true } },
      avatarMedium: true,
      emails: true,
      links: { orderBy: { index: "asc" } },
    },
    where: {
      oldUsername: username,
      usernameChanged: { isNotNull: true },
    },
    orderBy: { usernameChanged: "desc" },
  });
}

export async function updateAccount(
  fedCtx: RequestContext<ContextData>,
  account: Partial<NewAccount> & { id: Uuid; links?: Link[] },
): Promise<Account & { links: AccountLink[] } | undefined> {
  const { db } = fedCtx.data;
  const result = await updateAccountData(db, account);
  if (result == null) return undefined;
  let links: AccountLink[];
  if (account.links == null) {
    links = await db.query.accountLinkTable.findMany({
      where: { accountId: result.id },
      orderBy: { index: "asc" },
    });
  } else {
    links = await updateAccountLinks(
      db,
      result.id,
      new URL(`/@${account.username}`, fedCtx.origin).href,
      account.links,
    );
  }
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
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  return { ...result, links };
}

export async function updateAccountData(
  db: Database,
  account: Partial<Omit<NewAccount, "id">> & { id: Uuid },
): Promise<Account | undefined> {
  const values: Partial<Omit<NewAccount, "id">> = { ...account };
  if ("id" in values) delete values.id;
  const result = await db.update(accountTable).set({
    ...values,
    ...(values.username == null ? {} : {
      username: sql`
        CASE
          WHEN ${accountTable.usernameChanged} IS NULL
          THEN ${values.username}
          ELSE ${accountTable.username}
        END
      `,
      oldUsername: sql`
        CASE
          WHEN
            ${accountTable.username} = ${values.username} OR
            ${accountTable.usernameChanged} IS NOT NULL
          THEN NULL
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
    }),
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
    where: { accountId },
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
    ...link,
    ...meta,
    name: link.name,
    verified,
  })).filter((link) => link.url != null);
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

const LINK_PATTERN = /<(?:a|link)\s+([^>]*)>/gi;
const LINK_ATTRIBUTE_PATTERN =
  /\b([a-z-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/gi;

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
    const rel = attributes.rel?.toLowerCase()?.split(/\s+/g) ?? [];
    if (!rel.includes("me")) continue;
    const href = attributes.href;
    if (href == null || href.trim() === "") continue;
    const url = unescape(href.trim());
    if (!URL.canParse(url)) continue;
    const normalizedHref = new URL(url);
    if (normalizedHref.href === verifyUrl.toString()) return true;
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
    // deno-lint-ignore no-explicit-any
    const result = await response.json() as any;
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

export type RelationshipState =
  | "block"
  | "follow"
  | "request"
  | "none";

export interface Relationship {
  account: Account & { actor: Actor };
  target: Actor;
  outgoing: RelationshipState;
  incoming: RelationshipState;
}

export async function getRelationship(
  db: Database,
  account: Account & { actor: Actor } | null | undefined,
  target: Actor,
): Promise<Relationship | null> {
  if (account == null || account.actor.id === target.id) return null;
  const row = await db.query.actorTable.findFirst({
    where: {
      id: account.actor.id,
    },
    columns: {},
    with: {
      blockees: { where: { blockeeId: target.id } },
      blockers: { where: { blockerId: target.id } },
      followees: { where: { followeeId: target.id } },
      followers: { where: { followerId: target.id } },
    },
  });
  return {
    account,
    target,
    outgoing: row == null
      ? "none"
      : row.blockees.some((b) => b.blockeeId === target.id)
      ? "block"
      : row.followees.some((f) =>
          f.followeeId === target.id && f.accepted != null
        )
      ? "follow"
      : row.followees.some((f) => f.followeeId === target.id)
      ? "request"
      : "none",
    incoming: row == null
      ? "none"
      : row.blockers.some((b) => b.blockerId === target.id)
      ? "block"
      : row.followers.some((f) =>
          f.followerId === target.id && f.accepted != null
        )
      ? "follow"
      : row.followers.some((f) => f.followerId === target.id)
      ? "request"
      : "none",
  };
}

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.
 */
export function normalizeEmail(email: string): string;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `null`,
 *          it returns `null`.
 */
export function normalizeEmail(email: string | null): string | null;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `undefined`,
 *          it returns `undefined`.
 */
export function normalizeEmail(email: string | undefined): string | undefined;

/**
 * Normalizes an email address by trimming whitespace, converting the host
 * to lowercase (and to punycode if necessary), and ensuring it has a
 * single "@" character. If the email is invalid, it throws a `TypeError`.
 * @param email The email address to normalize.
 * @returns The normalized email address.  If the input is `undefined`,
 *          it returns `undefined`.  If the input is `null`, it returns `null`.
 */
export function normalizeEmail(
  email: string | null | undefined,
): string | null | undefined;

export function normalizeEmail(
  email: string | null | undefined,
): string | null | undefined {
  if (typeof email === "undefined") return undefined;
  else if (email == null) return null;
  const [local, host, shouldNotExist] = email.trim().split("@");
  if (
    local == null || local.trim() === "" || host == null ||
    host.trim() === "" || shouldNotExist != null
  ) {
    throw new TypeError("Invalid email format.");
  }
  const normalizedHost = new URL(`https://${host}/`).host;
  return `${local}@${normalizedHost}`;
}

export async function transformAvatar(
  input: Uint8Array | ArrayBuffer,
): Promise<{ buffer: Uint8Array; format: "jpeg" | "webp" }> {
  let image = sharp(input);
  const metadata = await image.metadata();
  let { width, height } = metadata;
  if (width == null || height == null) {
    throw new Error("Failed to read image metadata.");
  }
  if (width !== height) { // crop to square
    const size = Math.min(width, height);
    const left = ((width - size) / 2) | 0;
    const top = ((height - size) / 2) | 0;
    image = image.extract({ left, top, width: size, height: size });
    width = height = size;
  }
  if (width > 1024) {
    image = image.resize(1024);
    width = height = 1024;
  }
  let format: "jpeg" | "webp";
  if (metadata.hasAlpha) {
    image = image.webp({ quality: 90 });
    format = "webp";
  } else if (metadata.format !== "jpeg") {
    image = image.jpeg({ quality: 90 });
    format = "jpeg";
  } else {
    format = "jpeg";
  }
  const buffer = await image.toBuffer();
  return { buffer: new Uint8Array(buffer), format };
}

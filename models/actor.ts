import {
  type Context,
  type DocumentLoader,
  getActorHandle,
  getActorTypeName,
  isActor,
  Link,
  PropertyValue,
  traverseCollection,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type Keyv from "keyv";
import type { Database, RelationsFilter } from "../db.ts";
import metadata from "../deno.json" with { type: "json" };
import {
  getAvatarUrl as getAccountAvatarUrl,
  renderAccountLinks,
} from "./account.ts";
import { persistInstance } from "./instance.ts";
import { renderMarkup } from "./markup.ts";
import { isPostObject, persistPost, persistSharedPost } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  actorTable,
  followingTable,
  type Instance,
  instanceTable,
  type NewActor,
  type NewInstance,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
export { getAvatarUrl } from "./avatar.ts";

const logger = getLogger(["hackerspub", "models", "actor"]);

export async function syncActorFromAccount(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  account: Account & { emails: AccountEmail[]; links: AccountLink[] },
): Promise<
  Actor & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    instance: Instance;
  }
> {
  const instance: NewInstance = {
    host: fedCtx.host,
    software: "hackerspub",
    softwareVersion: metadata.version,
  };
  const instances = await db.insert(instanceTable)
    .values(instance)
    .onConflictDoUpdate({
      target: instanceTable.host,
      set: {
        ...instance,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning();
  const values: Omit<NewActor, "id"> = {
    iri: fedCtx.getActorUri(account.id).href,
    type: "Person",
    username: account.username,
    instanceHost: instance.host,
    handleHost: instance.host,
    accountId: account.id,
    name: account.name,
    bioHtml: (await renderMarkup(db, fedCtx, account.bio, {
      docId: account.id,
      kv,
    })).html,
    automaticallyApprovesFollowers: true,
    inboxUrl: fedCtx.getInboxUri(account.id).href,
    sharedInboxUrl: fedCtx.getInboxUri().href,
    avatarUrl: await getAccountAvatarUrl(account),
    fieldHtmls: Object.fromEntries(
      renderAccountLinks(account.links).map((
        pair,
      ) => [pair.name, pair.value]),
    ),
    url: new URL(`/@${account.username}`, fedCtx.origin).href,
    updated: account.updated,
    created: account.created,
    published: account.created,
  };
  const rows = await db.insert(actorTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: actorTable.accountId,
      set: values,
      setWhere: eq(actorTable.accountId, account.id),
    })
    .returning();
  return { ...rows[0], account, instance: instances[0] };
}

export async function persistActor(
  db: Database,
  ctx: Context<void>,
  actor: vocab.Actor,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    outbox?: boolean;
  } = {},
): Promise<
  Actor & {
    instance: Instance;
    account: Account | null;
    successor: Actor | null;
  } | undefined
> {
  if (actor.id == null) return undefined;
  else if (actor.inboxId == null) {
    logger.warn("Actor {actorId} has no inbox.", { actorId: actor.id.href });
    return undefined;
  }
  const instance = await persistInstance(db, actor.id.host);
  let handle: string;
  try {
    handle = await getActorHandle(actor, { trimLeadingAt: true });
  } catch (error) {
    logger.warn(
      "Failed to get handle for actor {actorId}: {error}",
      { actorId: actor.id.href, error },
    );
    return undefined;
  }
  const getterOpts = { ...options, suppressError: true };
  const [attachments, avatar, header, followees, followers] = await Promise.all(
    [
      Array.fromAsync(actor.getAttachments(getterOpts)),
      actor.getIcon(getterOpts),
      await actor.getImage(getterOpts),
      await actor.getFollowing(getterOpts),
      await actor.getFollowers(getterOpts),
    ],
  );
  const tags: Record<string, string> = {};
  const emojis: Record<string, string> = {};
  for await (const tag of actor.getTags(getterOpts)) {
    if (tag instanceof vocab.Hashtag) {
      if (tag.name == null || tag.href == null) continue;
      tags[tag.name.toString().toLowerCase()] = tag.href.href;
    } else if (tag instanceof vocab.Emoji) {
      if (tag.name == null) continue;
      const icon = await tag.getIcon(getterOpts);
      if (
        icon?.url == null ||
        icon.url instanceof vocab.Link && icon.url.href == null
      ) {
        continue;
      }
      emojis[tag.name.toString()] = icon.url instanceof URL
        ? icon.url.href
        : icon.url.href!.href;
    }
  }
  const successor = await actor.getSuccessor(getterOpts);
  const successorActor = isActor(successor)
    ? await persistActor(db, ctx, successor, options)
    : null;
  const values: Omit<NewActor, "id"> = {
    iri: actor.id.href,
    type: getActorTypeName(actor),
    username: handle.substring(0, handle.indexOf("@")),
    instanceHost: instance.host,
    handleHost: handle.substring(handle.indexOf("@") + 1),
    name: actor.name?.toString(),
    bioHtml: actor.summary?.toString(),
    automaticallyApprovesFollowers: !actor.manuallyApprovesFollowers,
    inboxUrl: actor.inboxId.href,
    sharedInboxUrl: actor.endpoints?.sharedInbox?.href,
    followersUrl: actor.followersId?.href,
    avatarUrl: avatar?.url instanceof Link
      ? avatar.url.href?.href
      : avatar?.url?.href,
    headerUrl: header?.url instanceof Link
      ? header.url.href?.href
      : header?.url?.href,
    fieldHtmls: Object.fromEntries(
      attachments.filter((a) => a instanceof PropertyValue).map(
        (p) => [p.name, p.value],
      ),
    ),
    emojis,
    tags,
    url: actor.url instanceof Link ? actor.url.href?.href : actor.url?.href,
    followeesCount: followees?.totalItems ?? 0,
    followersCount: followers?.totalItems ?? 0,
    aliases: actor.aliasIds?.map((a) => a.href),
    successorId:
      successorActor == null || !successorActor.aliases.includes(actor.id.href)
        ? null
        : successorActor.id,
    updated: actor.updated == null
      ? undefined
      : new Date(actor.updated.toString()),
    published: actor.published == null
      ? null
      : new Date(actor.published.toString()),
  };
  const rows = await db.insert(actorTable)
    .values({ ...values, id: generateUuidV7() })
    .onConflictDoUpdate({
      target: actorTable.iri,
      set: values,
      setWhere: eq(actorTable.iri, actor.id.href),
    })
    .returning();
  const result = { ...rows[0], instance };
  const featured = await actor.getFeatured(getterOpts);
  if (featured != null) {
    for await (const object of traverseCollection(featured, getterOpts)) {
      if (!isPostObject(object)) continue;
      await persistPost(db, ctx, object, {
        ...options,
        actor: result,
        replies: true,
      });
    }
  }
  const outbox = options.outbox ? await actor.getOutbox(getterOpts) : null;
  if (outbox != null) {
    let i = 0;
    for await (
      const activity of traverseCollection(outbox, getterOpts)
    ) {
      if (activity instanceof vocab.Create) {
        let object: vocab.Object | null;
        try {
          object = await activity.getObject(getterOpts);
        } catch (error) {
          logger.warn(
            "Failed to get object for activity {activityId}: {error}",
            { activityId: activity.id?.href, error },
          );
          continue;
        }
        if (!isPostObject(object)) continue;
        const persisted = await persistPost(db, ctx, object, {
          ...options,
          actor: result,
          replies: true,
        });
        if (persisted != null) i++;
      } else if (activity instanceof vocab.Announce) {
        const persisted = await persistSharedPost(db, ctx, activity, {
          ...options,
          actor: result,
        });
        if (persisted != null) i++;
      }
      if (i >= 10) break;
    }
  }
  return { ...result, account: null, successor: successorActor ?? null };
}

export function getPersistedActor(
  db: Database,
  iri: string | URL,
): Promise<
  Actor & { instance: Instance; account: Account | null } | undefined
> {
  return db.query.actorTable.findFirst({
    with: { instance: true, account: true },
    where: { iri: iri.toString() },
  });
}

export async function persistActorsByHandles(
  db: Database,
  ctx: Context<void>,
  handles: string[],
): Promise<Record<string, Actor & { instance: Instance }>> {
  const filter: RelationsFilter<"actorTable">[] = [];
  const handlesToFetch = new Set<string>();
  for (let handle of handles) {
    handle = handle.trim().replace(/^@/, "").trim();
    if (!handle.includes("@")) continue;
    let [username, host] = handle.split("@");
    username = username.trim();
    host = host.trim();
    if (username === "" || host === "") continue;
    handlesToFetch.add(`@${username}@${host}`);
    filter.push({
      username,
      OR: [
        { instanceHost: host },
        { handleHost: host },
      ],
    });
  }
  if (filter.length < 1) return {};
  const existingActors = await db.query.actorTable.findMany({
    with: { instance: true },
    where: { OR: [...filter] },
  });
  const result: Record<string, Actor & { instance: Instance }> = {};
  for (const actor of existingActors) {
    result[actor.handle] = actor;
    handlesToFetch.delete(actor.handle);
    if (actor.instanceHost !== actor.handleHost) {
      const handle = `@${actor.username}@${actor.instanceHost}`;
      result[handle] = actor;
      handlesToFetch.delete(handle);
    }
  }
  const documentLoader = await ctx.getDocumentLoader({
    identifier: new URL(ctx.canonicalOrigin).host,
  });
  const promises = [];
  for (const handle of handlesToFetch) {
    promises.push(
      ctx.lookupObject(handle, { documentLoader }).catch((error) => {
        logger.warn("Failed to lookup actor {handle}: {error}", {
          handle,
          error,
        });
        return null;
      }),
    );
  }
  const apActors = await Promise.all(promises);
  for (const apActor of apActors) {
    if (!isActor(apActor)) continue;
    const actor = await persistActor(db, ctx, apActor, {
      ...ctx,
      documentLoader,
      outbox: false,
    });
    if (actor == null) continue;
    const handle = `@${actor.username}@${actor.instance.host}`;
    result[handle] = actor;
  }
  return result;
}

export function toRecipient(actor: Actor): vocab.Recipient {
  return {
    id: new URL(actor.iri),
    inboxId: new URL(actor.inboxUrl),
    endpoints: actor.sharedInboxUrl == null ? null : {
      sharedInbox: new URL(actor.sharedInboxUrl),
    },
  };
}

export interface ActorStats {
  total: number;
  notes: number;
  notesWithReplies: number;
  shares: number;
  articles: number;
}

export async function getActorStats(
  db: Database,
  actorId: Uuid,
): Promise<ActorStats> {
  const rows = await db.select({
    total: count(),
    notes: sql<number>`
      coalesce(
        sum(
          CASE WHEN ${postTable.type} = 'Note' AND
                    ${postTable.replyTargetId} IS NULL AND
                    ${postTable.sharedPostId} IS NULL
            THEN 1
            ELSE 0
          END
        ),
        0
      )`,
    notesWithReplies: sql<number>`
      coalesce(
        sum(
          CASE WHEN ${postTable.type} = 'Note' AND
                    ${postTable.sharedPostId} IS NULL
            THEN 1
            ELSE 0
          END
        ),
        0
      )`,
    shares: sql<number>`
      coalesce(
        sum(CASE WHEN ${postTable.sharedPostId} IS NULL THEN 0 ELSE 1 END),
        0
      )
    `,
    articles: sql<number>`
      coalesce(
        sum(
          CASE WHEN ${postTable.type} = 'Article' AND
                    ${postTable.sharedPostId} IS NULL
            THEN 1
            ELSE 0
          END
        ),
        0
      )
    `,
  }).from(postTable).where(eq(postTable.actorId, actorId));
  if (rows.length > 0) return rows[0];
  return { total: 0, notes: 0, notesWithReplies: 0, shares: 0, articles: 0 };
}

export interface RecommendActorsOptions {
  mainLocale?: string;
  locales?: string[];
  account?: Account & { actor: Actor };
  limit?: number;
}

export async function recommendActors(
  db: Database,
  { mainLocale, locales, account, limit }: RecommendActorsOptions = {},
): Promise<(Actor & { account?: Account | null })[]> {
  const mainLanguage = mainLocale == null
    ? undefined
    : mainLocale.replace(/-.*$/, "");
  const languages = locales == null
    ? undefined
    : locales.map((l) => l.replace(/-.*$/, ""));
  if (languages != null && locales != null) {
    for (const locale of locales) {
      if (!languages.includes(locale)) languages.push(locale);
    }
  }
  const stats = db
    .select({
      actorId: actorTable.id,
      local: sql<number>`
        CASE
          WHEN ${actorTable.accountId} IS NULL THEN 0
          ELSE 1
        END`.as("local"),
      followersCount: actorTable.followersCount,
      reactionsCount: sql<number>`coalesce(sum(${postTable.reactionsCount}), 0)`
        .as("likesCount"),
      repliesCount: sql<number>`coalesce(sum(${postTable.repliesCount}), 0)`
        .as("repliesCount"),
      sharesCount: sql<number>`coalesce(sum(${postTable.sharesCount}), 0)`
        .as("sharesCount"),
      postsCount: sql<number>`
        sum(CASE
          WHEN ${postTable.language} = ${mainLocale ?? null} THEN 1
          WHEN ${postTable.language} = ${mainLanguage ?? null} THEN 1
          ELSE 0
        END)
      `.as("postsCount"),
    })
    .from(actorTable)
    .leftJoin(postTable, eq(postTable.actorId, actorTable.id))
    .where(
      and(
        eq(actorTable.type, "Person"),
        languages == null || languages.length < 1
          ? undefined
          : inArray(postTable.language, languages),
        account == null ? undefined : and(
          or(
            isNull(actorTable.accountId),
            ne(actorTable.accountId, account.id),
          ),
          notInArray(
            postTable.actorId,
            db.select({ followeeId: followingTable.followeeId }).from(
              followingTable,
            ).where(eq(followingTable.followerId, account.actor.id)),
          ),
        ),
      ),
    )
    .groupBy(
      actorTable.id,
      actorTable.accountId,
      actorTable.followersCount,
    );
  const statsCte = db.$with("stats").as(stats);
  const f1 = aliasedTable(followingTable, "f1");
  const f2 = aliasedTable(followingTable, "f2");
  const follows = db
    .select({
      followeeId: f2.followeeId,
      followersCount: count().as("followersCount"),
    })
    .from(f1)
    .innerJoin(f2, eq(f1.followeeId, f2.followerId))
    .where(
      account == null ? sql`false` : eq(f1.followerId, account.actor.id),
    )
    .groupBy(f2.followeeId);
  const followsCte = db.$with("follows").as(follows);
  const subquery = db.with(statsCte, followsCte)
    .select({ actorId: statsCte.actorId })
    .from(statsCte)
    .leftJoin(followsCte, eq(statsCte.actorId, followsCte.followeeId))
    .orderBy(
      desc(
        sql`
          ${statsCte.reactionsCount} / (${statsCte.reactionsCount} + 15.0) +
          ${statsCte.repliesCount} / (${statsCte.repliesCount} + 5.0) +
          ${statsCte.sharesCount} / (${statsCte.sharesCount} + 10.0) +
          ${statsCte.followersCount} / (${statsCte.followersCount} + 50.0) +
          CASE
            WHEN ${followsCte.followersCount} IS NULL THEN 0
            ELSE ${followsCte.followersCount} / (${followsCte.followersCount} + 5.0)
          END * 5+
          ${statsCte.postsCount} / (${statsCte.postsCount} + 15.0) * 5 +
          ${statsCte.local} * 5
          `,
      ),
    );
  const actorIds =
    (limit == null ? await subquery : await subquery.limit(limit))
      .map(({ actorId }) => actorId);
  if (actorIds.length < 1) return [];
  const actors = await db.query.actorTable.findMany({
    with: { account: true },
    where: { id: { in: actorIds } },
    limit,
  });
  actors.sort((a, b) => actorIds.indexOf(a.id) - actorIds.indexOf(b.id));
  return actors;
}

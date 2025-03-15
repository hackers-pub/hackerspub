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
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type Keyv from "keyv";
import type { Database } from "../db.ts";
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

const logger = getLogger(["hackerspub", "models", "actor"]);

export function getAvatarUrl(actor: Actor): string {
  return actor.avatarUrl ?? "https://gravatar.com/avatar/?d=mp&s=128";
}

export async function syncActorFromAccount(
  db: Database,
  _kv: Keyv,
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
    accountId: account.id,
    name: account.name,
    bioHtml: (await renderMarkup(db, fedCtx, account.id, account.bio)).html,
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
  actor: vocab.Actor,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    outbox?: boolean;
  } = {},
): Promise<Actor & { instance: Instance } | undefined> {
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
  const emojis: Record<string, string> = {};
  for await (const tag of actor.getTags(options)) {
    if (tag instanceof vocab.Emoji) {
      if (tag.name == null) continue;
      const icon = await tag.getIcon(options);
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
  const values: Omit<NewActor, "id"> = {
    iri: actor.id.href,
    type: getActorTypeName(actor),
    username: handle.substring(0, handle.indexOf("@")),
    instanceHost: instance.host,
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
    url: actor.url instanceof Link ? actor.url.href?.href : actor.url?.href,
    followeesCount: followees?.totalItems ?? 0,
    followersCount: followers?.totalItems ?? 0,
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
  const featured = await actor.getFeatured(options);
  if (featured != null) {
    for await (
      const object of traverseCollection(featured, {
        ...options,
        suppressError: true,
      })
    ) {
      if (!isPostObject(object)) continue;
      await persistPost(db, object, {
        ...options,
        actor: result,
        replies: true,
      });
    }
  }
  const outbox = options.outbox ? await actor.getOutbox(options) : null;
  if (outbox != null) {
    let i = 0;
    for await (
      const activity of traverseCollection(outbox, {
        ...options,
        suppressError: true,
      })
    ) {
      if (activity instanceof vocab.Create) {
        let object: vocab.Object | null;
        try {
          object = await activity.getObject(options);
        } catch (error) {
          logger.warn(
            "Failed to get object for activity {activityId}: {error}",
            { activityId: activity.id?.href, error },
          );
          continue;
        }
        if (!isPostObject(object)) continue;
        const persisted = await persistPost(db, object, {
          ...options,
          actor: result,
          replies: true,
        });
        if (persisted != null) i++;
      } else if (activity instanceof vocab.Announce) {
        const persisted = await persistSharedPost(db, activity, {
          ...options,
          actor: result,
        });
        if (persisted != null) i++;
      }
      if (i >= 10) break;
    }
  }
  return result;
}

export function getPersistedActor(
  db: Database,
  iri: string | URL,
): Promise<Actor & { instance: Instance } | undefined> {
  return db.query.actorTable.findFirst({
    with: { instance: true },
    where: eq(actorTable.iri, iri.toString()),
  });
}

export async function persistActorsByHandles(
  db: Database,
  ctx: Context<void>,
  handles: string[],
): Promise<Record<string, Actor & { instance: Instance }>> {
  const filter: SQL[] = [];
  const handlesToFetch = new Set<string>();
  for (let handle of handles) {
    handle = handle.trim().replace(/^@/, "").trim();
    if (!handle.includes("@")) continue;
    let [username, host] = handle.split("@");
    username = username.trim();
    host = host.trim();
    if (username === "" || host === "") continue;
    handlesToFetch.add(`@${username}@${host}`);
    const expr = and(
      eq(actorTable.username, username),
      eq(actorTable.instanceHost, host),
    );
    if (expr != null) filter.push(expr);
  }
  if (filter.length < 1) return {};
  const existingActors = await db.query.actorTable.findMany({
    with: { instance: true },
    where: or(...filter),
  });
  const result: Record<string, Actor & { instance: Instance }> = {};
  for (const actor of existingActors) {
    const handle = `@${actor.username}@${actor.instance.host}`;
    result[handle] = actor;
    handlesToFetch.delete(handle);
  }
  const documentLoader = await ctx.getDocumentLoader({
    identifier: new URL(ctx.canonicalOrigin).host,
  });
  const promises = [];
  for (const handle of handlesToFetch) {
    promises.push(ctx.lookupObject(handle, { documentLoader }));
  }
  const apActors = await Promise.all(promises);
  for (const apActor of apActors) {
    if (!isActor(apActor)) continue;
    const actor = await persistActor(db, apActor, {
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
  mainLanguage?: string;
  languages?: string[];
  account?: Account & { actor: Actor };
  limit?: number;
}

export async function recommendActors(
  db: Database,
  { mainLanguage, languages, account, limit }: RecommendActorsOptions = {},
): Promise<(Actor & { account?: Account | null })[]> {
  if (mainLanguage != null) {
    mainLanguage = mainLanguage.replace(/-.*$/, "");
  }
  if (languages != null) {
    languages = languages.map((lang) => lang.replace(/-.*$/, ""));
  }
  const subquery = db.select({ actorId: postTable.actorId })
    .from(postTable)
    .innerJoin(actorTable, eq(postTable.actorId, actorTable.id))
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
    .groupBy(postTable.actorId, actorTable.accountId, actorTable.followersCount)
    .orderBy(
      desc(
        sql`
          (
            sum(
              ${postTable.likesCount} / (${postTable.likesCount} + 15.0) +
              ${postTable.repliesCount} / (${postTable.repliesCount} + 5.0) +
              ${postTable.sharesCount} / (${postTable.sharesCount} + 10.0)
            ) / (
              sum(
                ${postTable.likesCount} / (${postTable.likesCount} + 15.0) +
                ${postTable.repliesCount} / (${postTable.repliesCount} + 5.0) +
                ${postTable.sharesCount} / (${postTable.sharesCount} + 10.0)
              ) + 100
            )
          ) +
          (
            sum(CASE
              WHEN ${postTable.language} = ${mainLanguage ?? null} THEN 1
              ELSE 0
            END) /
            (sum(CASE
              WHEN ${postTable.language} = ${mainLanguage ?? null} THEN 1
              ELSE 0
            END) + 15.0)
          ) * 10 +
          ${actorTable.followersCount} / (${actorTable.followersCount} + 50.0) +
          CASE WHEN ${actorTable.accountId} IS NULL THEN 0 ELSE 1 END
          `,
      ),
    );
  const actorIds =
    (limit == null ? await subquery : await subquery.limit(limit))
      .map(({ actorId }) => actorId);
  if (actorIds.length < 1) return [];
  const actors = await db.query.actorTable.findMany({
    with: { account: true },
    where: inArray(actorTable.id, actorIds),
    limit,
  });
  actors.sort((a, b) => actorIds.indexOf(a.id) - actorIds.indexOf(b.id));
  return actors;
}

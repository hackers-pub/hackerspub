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
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import metadata from "../deno.json" with { type: "json" };
import { getAvatarUrl, renderAccountLinks } from "./account.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  actorTable,
  type Instance,
  instanceTable,
  type NewActor,
  type NewInstance,
} from "./schema.ts";
import { renderMarkup } from "./markup.ts";
import { persistInstance } from "./instance.ts";
import { isPostObject, persistPost, persistSharedPost } from "./post.ts";
import { generateUuidV7 } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "actor"]);

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
    avatarUrl: await getAvatarUrl(account),
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
  const attachments = await Array.fromAsync(actor.getAttachments(options));
  const avatar = await actor.getIcon(options);
  const header = await actor.getImage(options);
  const [followees, followers] = await Promise.all([
    await actor.getFollowing(options),
    await actor.getFollowers(options),
  ]);
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
  const promises = [];
  for (const handle of handlesToFetch) {
    promises.push(ctx.lookupObject(handle));
  }
  const apActors = await Promise.all(promises);
  for (const apActor of apActors) {
    if (!isActor(apActor)) continue;
    const actor = await persistActor(db, apActor, { ...ctx, outbox: false });
    if (actor == null) continue;
    const handle = `@${actor.username}@${actor.instance.host}`;
    result[handle] = actor;
  }
  return result;
}

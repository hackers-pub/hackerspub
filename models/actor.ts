import {
  type Context,
  getActorHandle,
  getActorTypeName,
  Link,
  PropertyValue,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { generate as uuidv7 } from "@std/uuid/unstable-v7";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import { renderAccountLinks } from "./account.ts";
import {
  type Account,
  type AccountLink,
  type Actor,
  actorTable,
  instanceTable,
  type NewActor,
  NewInstance,
} from "./schema.ts";
import { renderMarkup } from "./markup.ts";
import { persistInstance } from "./instance.ts";

const logger = getLogger(["hackerspub", "models", "actor"]);

export async function syncActorFromAccount(
  db: Database,
  kv: Deno.Kv,
  fedCtx: Context<void>,
  account: Account & { links: AccountLink[] },
): Promise<Actor> {
  const instance: NewInstance = {
    host: new URL(fedCtx.origin).host,
    software: "hackerspub",
    softwareVersion: "0.0.0", // FIXME
  };
  await db.insert(instanceTable)
    .values(instance)
    .onConflictDoUpdate({
      target: instanceTable.host,
      set: {
        ...instance,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
  const values: Omit<NewActor, "id"> = {
    iri: fedCtx.getActorUri(account.id).href,
    type: "Person",
    username: account.username,
    instanceHost: instance.host,
    accountId: account.id,
    name: account.name,
    bioHtml: (await renderMarkup(kv, account.id, account.bio)).html,
    automaticallyApprovesFollowers: true,
    inboxUrl: fedCtx.getInboxUri(account.id).href,
    sharedInboxUrl: fedCtx.getInboxUri().href,
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
    .values({ id: uuidv7(), ...values })
    .onConflictDoUpdate({
      target: actorTable.accountId,
      set: values,
      setWhere: eq(actorTable.accountId, account.id),
    })
    .returning();
  return rows[0];
}

export async function persistActor(
  db: Database,
  actor: vocab.Actor,
): Promise<Actor | undefined> {
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
  const attachments = await Array.fromAsync(actor.getAttachments());
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
    fieldHtmls: Object.fromEntries(
      attachments.filter((a) => a instanceof PropertyValue).map(
        (p) => [p.name, p.value],
      ),
    ),
    url: actor.url instanceof Link ? actor.url.href?.href : actor.url?.href,
    updated: actor.updated == null
      ? undefined
      : new Date(actor.updated.toString()),
    published: actor.published == null
      ? null
      : new Date(actor.published.toString()),
  };
  const rows = await db.insert(actorTable)
    .values({ ...values, id: uuidv7() })
    .onConflictDoUpdate({
      target: actorTable.iri,
      set: values,
      setWhere: eq(actorTable.iri, actor.id.href),
    })
    .returning();
  return rows[0];
}

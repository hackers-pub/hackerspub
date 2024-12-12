import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, eq, sql } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import { getArticle } from "../federation/objects.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  accountTable,
  type Actor,
  type ArticleDraft,
  articleDraftTable,
  type ArticleSource,
  articleSourceTable,
  type Instance,
  type NewArticleDraft,
  type NewArticleSource,
  type Post,
} from "./schema.ts";
import { syncPostFromArticleSource } from "./post.ts";
import { generateUuidV7, Uuid } from "./uuid.ts";

export async function updateArticleDraft(
  db: Database,
  draft: NewArticleDraft,
): Promise<ArticleDraft> {
  if (draft.tags != null) {
    let tags = draft.tags
      .map((tag) => tag.trim().replace(/^#\s*/, ""))
      .filter((tag) => tag !== "" && !tag.includes(","));
    tags = tags.filter((tag, index) => tags.indexOf(tag) === index);
    draft = { ...draft, tags };
  }
  const rows = await db.insert(articleDraftTable)
    .values(draft)
    .onConflictDoUpdate({
      target: [articleDraftTable.id],
      set: {
        ...draft,
        updated: sql`CURRENT_TIMESTAMP`,
        created: undefined,
      },
      setWhere: and(
        eq(articleDraftTable.id, draft.id),
        eq(articleDraftTable.accountId, draft.accountId),
      ),
    })
    .returning();
  return rows[0];
}

export async function deleteArticleDraft(
  db: Database,
  accountId: Uuid,
  draftId: Uuid,
): Promise<ArticleDraft | undefined> {
  const rows = await db.delete(articleDraftTable)
    .where(
      and(
        eq(articleDraftTable.accountId, accountId),
        eq(articleDraftTable.id, draftId),
      ),
    )
    .returning();
  return rows[0];
}

export async function createArticleSource(
  db: Database,
  source: Omit<NewArticleSource, "id"> & { id?: Uuid },
): Promise<ArticleSource | undefined> {
  const rows = await db.insert(articleSourceTable)
    .values({ id: generateUuidV7(), ...source })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

export async function createArticle(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  source: Omit<NewArticleSource, "id"> & { id?: Uuid },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  } | undefined
> {
  const articleSource = await createArticleSource(db, source);
  if (articleSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: eq(accountTable.id, source.accountId),
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromArticleSource(db, kv, fedCtx, {
    ...articleSource,
    account,
  });
  const articleObject = await getArticle(fedCtx, { ...articleSource, account });
  await fedCtx.sendActivity(
    { identifier: source.accountId },
    "followers",
    new vocab.Create({
      id: new URL("#create", articleObject.id ?? fedCtx.origin),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    }),
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return post;
}

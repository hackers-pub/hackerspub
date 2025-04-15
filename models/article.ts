import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, eq, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "../db.ts";
import { getArticle } from "../federation/objects.ts";
import { syncPostFromArticleSource } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type ArticleDraft,
  articleDraftTable,
  type ArticleSource,
  articleSourceTable,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type NewArticleDraft,
  type NewArticleSource,
  type Post,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

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

export async function getArticleSource(
  db: Database,
  username: string,
  publishedYear: number,
  slug: string,
  signedAccount?: Account & { actor: Actor },
): Promise<
  ArticleSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    post: Post & {
      actor: Actor & {
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      replyTarget: Post | null;
      mentions: (Mention & { actor: Actor })[];
      shares: Post[];
      reactions: Reaction[];
    };
  } | undefined
> {
  let account = await db.query.accountTable.findFirst({
    where: { username },
  });
  if (account == null) {
    account = await db.query.accountTable.findFirst({
      where: {
        oldUsername: username,
        usernameChanged: { isNotNull: true },
      },
      orderBy: { usernameChanged: "desc" },
    });
  }
  if (account == null) return undefined;
  return await db.query.articleSourceTable.findFirst({
    with: {
      account: {
        with: { emails: true, links: true },
      },
      post: {
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: true,
          mentions: {
            with: { actor: true },
          },
          shares: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
        },
      },
    },
    where: {
      slug,
      publishedYear,
      accountId: account.id,
    },
  });
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
  disk: Disk,
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
    where: { id: source.accountId },
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromArticleSource(db, kv, disk, fedCtx, {
    ...articleSource,
    account,
  });
  await addPostToTimeline(db, post);
  const articleObject = await getArticle(db, disk, fedCtx, {
    ...articleSource,
    account,
  });
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

export async function updateArticleSource(
  db: Database,
  id: Uuid,
  source: Partial<NewArticleSource>,
): Promise<ArticleSource | undefined> {
  const rows = await db.update(articleSourceTable)
    .set({ ...source, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(articleSourceTable.id, id))
    .returning();
  return rows[0];
}

export async function updateArticle(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<void>,
  articleSourceId: Uuid,
  source: Partial<NewArticleSource>,
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
  const articleSource = await updateArticleSource(db, articleSourceId, source);
  if (articleSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: { id: articleSource.accountId },
    with: { emails: true, links: true },
  });
  if (account == null) return undefined;
  const post = await syncPostFromArticleSource(db, kv, disk, fedCtx, {
    ...articleSource,
    account,
  });
  const articleObject = await getArticle(db, disk, fedCtx, {
    ...articleSource,
    account,
  });
  await fedCtx.sendActivity(
    { identifier: articleSource.accountId },
    "followers",
    new vocab.Update({
      id: new URL(
        `#update/${articleSource.updated.toISOString()}`,
        articleObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    }),
    {
      preferSharedInbox: true,
      excludeBaseUris: [
        new URL(fedCtx.origin),
        new URL(fedCtx.canonicalOrigin),
      ],
    },
  );
  return post;
}

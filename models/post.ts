import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { eq } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type ArticleSource,
  type Instance,
  type NewPost,
  type Post,
  postTable,
} from "./schema.ts";
import { syncActorFromAccount } from "./actor.ts";
import { renderMarkup } from "./markup.ts";
import { generateUuidV7 } from "./uuid.ts";

export async function syncPostFromArticleSource(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  articleSource: ArticleSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  }
> {
  const actor = await syncActorFromAccount(
    db,
    kv,
    fedCtx,
    articleSource.account,
  );
  const rendered = await renderMarkup(articleSource.id, articleSource.content);
  const url =
    `${fedCtx.origin}/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    type: "Article",
    actorId: actor.id,
    articleSourceId: articleSource.id,
    summary: articleSource.title,
    contentHtml: rendered.html,
    language: articleSource.language,
    tags: Object.fromEntries(
      articleSource.tags.map((
        tag,
      ) => [tag, `${fedCtx.origin}/tags/${encodeURIComponent(tag)}`]),
    ),
    url,
    updated: articleSource.updated,
    published: articleSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.articleSourceId,
      set: values,
      setWhere: eq(postTable.articleSourceId, articleSource.id),
    })
    .returning();
  return { ...rows[0], actor, articleSource };
}

import { LanguageString, PUBLIC_COLLECTION } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { renderMarkup } from "../models/markup.ts";
import { articleSourceTable } from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";

federation.setObjectDispatcher(
  vocab.Article,
  "/ap/articles/{id}",
  async (ctx, values) => {
    if (!validateUuid(values.id)) return null;
    const articleSource = await db.query.articleSourceTable.findFirst({
      with: { account: true },
      where: eq(articleSourceTable.id, values.id),
    });
    if (articleSource == null) return null;
    const rendered = await renderMarkup(
      articleSource.id,
      articleSource.content,
    );
    return new vocab.Article({
      id: ctx.getObjectUri(vocab.Article, { id: articleSource.id }),
      attribution: ctx.getActorUri(articleSource.accountId),
      to: PUBLIC_COLLECTION,
      summaries: [
        new LanguageString(articleSource.title, articleSource.language),
        articleSource.title,
      ],
      contents: [
        new LanguageString(rendered.html, articleSource.language),
        rendered.html,
      ],
      source: new vocab.Source({
        content: articleSource.content,
        mediaType: "text/markdown",
      }),
      tags: articleSource.tags.map((tag) =>
        new vocab.Hashtag({
          name: tag,
          href: new URL(`/tags/${encodeURIComponent(tag)}`, ctx.origin),
        })
      ),
      url: new URL(
        `/@${articleSource.account.username}/${articleSource.publishedYear}/${
          encodeURIComponent(articleSource.slug)
        }`,
        ctx.origin,
      ),
      published: articleSource.published.toTemporalInstant(),
      updated: +articleSource.updated > +articleSource.published
        ? articleSource.updated.toTemporalInstant()
        : null,
    });
  },
);

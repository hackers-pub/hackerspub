import { findNearestLocale, isLocale } from "@hackerspub/models/i18n";
import type { ArticleContent } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { minBy } from "@std/collections/min-by";
import {
  isPostCensoredFor,
  redactCensoredArticleContent,
} from "../../../../censorship.ts";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  if (!validateUuid(ctx.params.id)) return ctx.next();
  const contents = await db.query.articleContentTable.findMany({
    where: {
      sourceId: ctx.params.id,
    },
  });
  const languages = contents.map((c) => c.language).filter(isLocale);
  let content: ArticleContent | undefined;
  for (const locale of ctx.state.locales) {
    const found = findNearestLocale(locale, languages);
    if (found == null) continue;
    content = contents.find((c) => c.language === found);
    break;
  }
  if (content == null) {
    const originalContents = contents.filter((c) => c.originalLanguage == null);
    if (originalContents.length === 0) return ctx.next();
    content = minBy(originalContents, (c) => +c.published);
    if (content == null) return ctx.next();
  }
  // Censored articles stay reachable, but the title, body, and summary
  // are replaced with a notice for everyone except the author and
  // moderators.
  const post = await db.query.postTable.findFirst({
    where: { articleSourceId: ctx.params.id },
    columns: { censored: true, actorId: true },
  });
  if (post != null && isPostCensoredFor(post, ctx.state.account)) {
    content = redactCensoredArticleContent(content, ctx.state.t);
  }
  // The response depends on the viewer (censorship redaction above), so
  // it must not be cached or served across viewers.
  return new Response(
    JSON.stringify(content),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    },
  );
});

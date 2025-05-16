import { getAvatarUrl } from "@hackerspub/models/account";
import {
  getArticleSource,
  getOriginalArticleContent,
} from "@hackerspub/models/article";
import { renderMarkup } from "@hackerspub/models/markup";
import { isPostVisibleTo } from "@hackerspub/models/post";
import {
  type ArticleContent,
  articleContentTable,
} from "@hackerspub/models/schema";
import { and, eq } from "drizzle-orm";
import { html } from "satori-html";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { kv } from "../../../../kv.ts";
import { drawOgImage } from "../../../../og.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const { account } = article;
    const language = ctx.url.searchParams.get("l");
    let content: ArticleContent | undefined;
    if (language == null) {
      content = getOriginalArticleContent(article);
    } else {
      content = article.contents.find((c) =>
        c.language.toLowerCase() === language.toLowerCase()
      );
    }
    if (content == null) return ctx.next();
    const disk = drive.use();
    const rendered = await renderMarkup(
      ctx.state.fedCtx,
      content.content,
      { kv },
    );
    const ogImageKey = await drawOgImage(
      disk,
      content.ogImageKey,
      html`
        <div style="display: flex; flex-direction: column; width: 1200px; height: 630px; background-color: white;">
          <div style="display: flex; flex-direction: row; gap: 25px; height: 530px; padding: 25px;">
            <img
              src="${await getAvatarUrl(disk, account)}"
              width="125"
              height="125"
            >
            <div style="display: flex; flex-direction: column;">
              <div
                lang="${content.language}"
                style="font-size: 42px; margin-top: -12px; width: 1000px;"
              >
                ${content.title}
              </div>
              <div style="font-size: 32px; margin-top: 25px; color: gray;">
                ${account.name}
              </div>
              <div
                lang="${content.language}"
                style="width: 1000px; height: 355px; margin-top: 25px; font-size: 32px; overflow: hidden; text-overflow: ellipsis;"
              >
                ${rendered.text}
              </div>
            </div>
          </div>
          <div style="background-color: black; color: white; padding: 25px; height: 100px; font-size: 32px; font-weight: 600;">
            Hackers' Pub
          </div>
        </div>
      `,
    );
    if (ogImageKey !== content.ogImageKey) {
      await db.update(articleContentTable)
        .set({ ogImageKey })
        .where(
          and(
            eq(articleContentTable.sourceId, content.sourceId),
            eq(articleContentTable.language, content.language),
          ),
        );
    }
    return ctx.redirect(await disk.getUrl(ogImageKey));
  },
});

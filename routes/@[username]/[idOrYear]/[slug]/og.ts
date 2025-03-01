import { html } from "satori-html";
import { db } from "../../../../db.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { renderMarkup } from "../../../../models/markup.ts";
import { isPostVisibleTo } from "../../../../models/post.ts";
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
    );
    if (article == null) return ctx.next();
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const { account } = article;
    const content = await renderMarkup(
      db,
      ctx.state.fedCtx,
      null,
      article.content,
    );
    const png = await drawOgImage(
      html`
        <div style="
          display: flex; flex-direction: column;
          width: 1200px; height: 630px;
          background-color: white;
        ">
          <div style="
            display: flex; flex-direction: row; gap: 25px;
            height: 530px; padding: 25px;
          ">
            <img src="${await getAvatarUrl(account)}" width="125" height="125">
            <div style="display: flex; flex-direction: column;">
              <div style="font-size: 42px; margin-top: -12px; width: 1000px;">
                ${article.title}
              </div>
              <div style="font-size: 32px; margin-top: 25px; color: gray;">
                ${account.name}
              </div>
              <div style="
                width: 1000px; height: 355px; margin-top: 25px; font-size: 32px;
                overflow: hidden; text-overflow: ellipsis;
              ">
                ${content.text}
              </div>
            </div>
          </div>
          <div style="
            background-color: black; color: white;
            padding: 25px; height: 100px;
            font-size: 32px; font-weight: 600;
          ">
            Hackers' Pub
          </div>
        </div>
      `,
    );
    return new Response(
      png,
      { headers: { "Content-Type": "image/png" } },
    );
  },
});

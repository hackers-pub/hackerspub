import { eq } from "drizzle-orm";
import { html } from "satori-html";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { getAvatarUrl } from "../../models/account.ts";
import { renderMarkup } from "../../models/markup.ts";
import { accountTable } from "../../models/schema.ts";
import { drawOgImage } from "../../og.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const account = await db.query.accountTable.findFirst({
      with: { emails: true },
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account == null) return ctx.next();
    const disk = drive.use();
    const bio = await renderMarkup(db, ctx.state.fedCtx, null, account.bio);
    const ogImageKey = await drawOgImage(
      disk,
      account.ogImageKey,
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
              <div style="font-size: 64px; margin-top: -20px;">
                ${account.name}
              </div>
              <div style="font-size: 32px; color: gray;">
                @${account.username}@${ctx.url.host}
              </div>
              <div style="
                width: 1000px; height: 355px; margin-top: 25px; font-size: 32px;
                overflow: hidden; text-overflow: ellipsis;
              ">
                ${bio.text}
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
    if (ogImageKey !== account.ogImageKey) {
      await db.update(accountTable)
        .set({ ogImageKey })
        .where(eq(accountTable.id, account.id));
    }
    return ctx.redirect(await disk.getUrl(ogImageKey));
  },
});

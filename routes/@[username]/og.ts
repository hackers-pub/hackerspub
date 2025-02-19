import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { dirname, join } from "@std/path";
import { eq } from "drizzle-orm";
import satori from "satori";
import { html } from "satori-html";
import { db } from "../../db.ts";
import { getAvatarUrl } from "../../models/account.ts";
import { renderMarkup } from "../../models/markup.ts";
import { accountTable } from "../../models/schema.ts";
import { define } from "../../utils.ts";

await initWasm(
  "https://unpkg.com/@resvg/resvg-wasm/index_bg.wasm",
);

async function loadFont(filename: string): Promise<ArrayBuffer> {
  const f = await Deno.readFile(join(
    dirname(dirname(import.meta.dirname!)),
    "fonts",
    filename,
  ));
  return f.buffer;
}

export const handler = define.handlers({
  async GET(ctx) {
    const account = await db.query.accountTable.findFirst({
      with: { emails: true },
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account == null) return ctx.next();
    const bio = await renderMarkup(db, ctx.state.fedCtx, null, account.bio);
    const svg = await satori(
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
      {
        width: 1200,
        height: 630,
        fonts: [
          {
            name: "Noto Sans",
            data: await loadFont("NotoSans-Regular.ttf"),
            weight: 400,
            style: "normal",
          },
          {
            name: "Noto Sans",
            data: await loadFont("NotoSans-SemiBold.ttf"),
            weight: 600,
            style: "normal",
          },
          {
            name: "Noto Sans JP",
            data: await loadFont("NotoSansJP-Regular.ttf"),
            weight: 400,
            style: "normal",
          },
          {
            name: "Noto Sans KR",
            data: await loadFont("NotoSansKR-Regular.ttf"),
            weight: 400,
            style: "normal",
          },
          {
            name: "Noto Sans SC",
            data: await loadFont("NotoSansSC-Regular.ttf"),
            weight: 400,
            style: "normal",
          },
          {
            name: "Noto Sans TC",
            data: await loadFont("NotoSansTC-Regular.ttf"),
            weight: 400,
            style: "normal",
          },
        ],
      },
    );
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: 1200,
      },
    });
    const renderedImage = resvg.render();
    const pngBuffer = renderedImage.asPng();
    return new Response(
      pngBuffer,
      {
        headers: {
          "Content-Type": "image/png",
        },
      },
    );
  },
});

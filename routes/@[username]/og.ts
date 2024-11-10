import { dirname, join } from "@std/path";
import { eq } from "drizzle-orm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import { html } from "satori-html";
import { define } from "../../utils.ts";
import { db } from "../../db.ts";
import { accountTable } from "../../models/schema.ts";

await initWasm(
  "https://unpkg.com/@resvg/resvg-wasm/index_bg.wasm",
);

function loadFont(filename: string): Promise<Uint8Array> {
  return Deno.readFile(join(
    dirname(dirname(import.meta.dirname!)),
    "fonts",
    filename,
  ));
}

export const handler = define.handlers({
  async GET(ctx) {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account == null) return ctx.next();
    const svg = await satori(
      html`
        <div style="
          display: flex; flex-direction: column;
          width: 1200px; height: 630px;
          background-color: white;
        ">
          <div style="
            display: flex; flex-direction: column;
            height: 530px; padding: 25px;
          ">
            <div style="font-size: 64px">
              ${account.name}
            </div>
            <div style="font-size: 32px; color: gray;">
              @${account.username}@${ctx.url.host}
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

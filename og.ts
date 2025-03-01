import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { join } from "@std/path";
import satori from "satori";

await initWasm(
  "https://unpkg.com/@resvg/resvg-wasm/index_bg.wasm",
);

async function loadFont(filename: string): Promise<ArrayBuffer> {
  const f = await Deno.readFile(join(
    import.meta.dirname!,
    "fonts",
    filename,
  ));
  return f.buffer;
}

type Weight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type FontStyle = "normal" | "italic";
interface FontOptions {
  data: ArrayBuffer;
  name: string;
  weight?: Weight;
  style?: FontStyle;
  lang?: string;
}

const FONTS: FontOptions[] = [
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
  {
    name: "Noto Emoji",
    data: await loadFont("NotoEmoji-Regular.ttf"),
    weight: 400,
    style: "normal",
  },
];

export async function drawOgImage(
  html: Parameters<typeof satori>[0],
  size: { width: number; height: number } = { width: 1200, height: 630 },
): Promise<Uint8Array> {
  const svg = await satori(html, { ...size, fonts: FONTS });
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: size.width,
    },
  });
  const renderedImage = resvg.render();
  return renderedImage.asPng();
}

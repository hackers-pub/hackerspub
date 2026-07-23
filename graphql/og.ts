import { Resvg } from "@resvg/resvg-js";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type { Disk } from "flydrive";
import { canonicalize } from "json-canonicalize";
import satori from "satori";
import sharp from "sharp";

const OG_VERSION = "v2-5";
const OG_NAMESPACE = "og/v2";
const OG_SIZE = { width: 1200, height: 630 } as const;
const FALLBACK_IMAGE_DATA_URI = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 3_000;

// satori 0.11.x decodes base64 data URIs only for PNG, APNG, JPEG, GIF,
// and SVG; other MIME types (notably WEBP, which `transformAvatar`
// writes for avatars with alpha) cause it to spread `undefined` and
// throw "TypeError: a is not iterable". Re-encode anything else as PNG
// before embedding so the OG renderer always receives something it can
// read.
const SATORI_SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
]);

// Avatars are rendered at 172x172 (profile) / 82x82 (article) in the
// 1200x630 OG bitmap, so 384px is plenty of source resolution. Capping
// the decoded pixel count and the output dimensions keeps a hostile
// upstream from turning a tiny WEBP/AVIF into a multi-megabyte PNG.
const TRANSCODE_MAX_PIXELS = 4096 * 4096;
const TRANSCODE_MAX_DIMENSION = 384;

type Weight = 400 | 600;
type FontStyle = "normal";

interface FontOptions {
  data: ArrayBuffer;
  name: string;
  weight: Weight;
  style: FontStyle;
  lang?: string;
}

type OgElement = {
  type: string;
  props: Record<string, unknown>;
};

interface ProfileOgImageInput {
  avatarKey: string;
  avatarUrl: string;
  bio: string;
  displayName: string;
  handle: string;
}

interface ArticleOgImageInput {
  authorName: string;
  avatarKey: string;
  avatarUrl: string;
  excerpt: string;
  handle: string;
  language: string;
  sourceId: string;
  title: string;
}

let fontsPromise: Promise<FontOptions[]> | undefined;
let brandLogoDataUriPromise: Promise<string> | undefined;

async function loadFont(filename: string): Promise<ArrayBuffer> {
  const data = await Deno.readFile(join(
    import.meta.dirname!,
    "assets",
    "fonts",
    filename,
  ));
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  );
}

function loadFonts(): Promise<FontOptions[]> {
  fontsPromise ??= Promise.all([
    loadFont("NotoSans-Regular.ttf").then((data) => ({
      name: "Noto Sans",
      data,
      weight: 400 as const,
      style: "normal" as const,
    })),
    loadFont("NotoSans-SemiBold.ttf").then((data) => ({
      name: "Noto Sans",
      data,
      weight: 600 as const,
      style: "normal" as const,
    })),
    loadFont("NotoSansJP-Regular.ttf").then((data) => ({
      name: "Noto Sans JP",
      data,
      weight: 400 as const,
      style: "normal" as const,
      lang: "ja-JP",
    })),
    loadFont("NotoSansKR-Regular.ttf").then((data) => ({
      name: "Noto Sans KR",
      data,
      weight: 400 as const,
      style: "normal" as const,
      lang: "ko-KR",
    })),
    loadFont("NotoSansSC-Regular.ttf").then((data) => ({
      name: "Noto Sans SC",
      data,
      weight: 400 as const,
      style: "normal" as const,
      lang: "zh-CN",
    })),
    loadFont("NotoSansTC-Regular.ttf").then((data) => ({
      name: "Noto Sans TC",
      data,
      weight: 400 as const,
      style: "normal" as const,
      lang: "zh-TW",
    })),
    loadFont("NotoEmoji-Regular.ttf").then((data) => ({
      name: "Noto Emoji",
      data,
      weight: 400 as const,
      style: "normal" as const,
    })),
  ]);
  return fontsPromise;
}

async function loadBrandLogoDataUri(): Promise<string> {
  brandLogoDataUriPromise ??= Deno.readFile(
    join(import.meta.dirname!, "..", "web-next", "public", "logo-dark.svg"),
  ).then((svg) => `data:image/svg+xml;base64,${encodeBase64(svg)}`);
  return brandLogoDataUriPromise;
}

interface ImageDataUriOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export async function loadImageDataUri(
  imageUrl: string,
  options: ImageDataUriOptions = {},
): Promise<string> {
  if (imageUrl.startsWith("data:")) return imageUrl;
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return FALLBACK_IMAGE_DATA_URI;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return FALLBACK_IMAGE_DATA_URI;
  }
  const maxBytes = options.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return FALLBACK_IMAGE_DATA_URI;
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength != null &&
      Number.parseInt(contentLength, 10) > maxBytes
    ) {
      await response.body?.cancel().catch(() => {});
      return FALLBACK_IMAGE_DATA_URI;
    }
    let contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim()
        .toLowerCase() ?? "application/octet-stream";
    if (!contentType.startsWith("image/")) {
      await response.body?.cancel().catch(() => {});
      return FALLBACK_IMAGE_DATA_URI;
    }
    let bytes = await readResponseBytes(response, maxBytes);
    if (bytes == null) return FALLBACK_IMAGE_DATA_URI;
    if (!SATORI_SUPPORTED_IMAGE_TYPES.has(contentType)) {
      try {
        bytes = new Uint8Array(
          await sharp(bytes, { limitInputPixels: TRANSCODE_MAX_PIXELS })
            .resize({
              width: TRANSCODE_MAX_DIMENSION,
              height: TRANSCODE_MAX_DIMENSION,
              fit: "inside",
              withoutEnlargement: true,
            })
            .png()
            .toBuffer(),
        );
      } catch {
        return FALLBACK_IMAGE_DATA_URI;
      }
      if (bytes.byteLength > maxBytes) return FALLBACK_IMAGE_DATA_URI;
      contentType = "image/png";
    }
    return `data:${contentType};base64,${encodeBase64(bytes)}`;
  } catch {
    return FALLBACK_IMAGE_DATA_URI;
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (response.body == null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function h(
  type: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): OgElement {
  return {
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 1 ? children[0] : children,
    },
  };
}

export function truncateText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const graphemes = typeof Intl.Segmenter === "function"
    ? Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        compact,
      ),
      ({ segment }) => segment,
    )
    : Array.from(compact);
  if (graphemes.length <= maxLength) return compact;
  return `${graphemes.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

function brandFooter(logo: string): OgElement {
  return h(
    "div",
    {
      style: {
        alignItems: "center",
        background: "#000000",
        bottom: 0,
        display: "flex",
        flexDirection: "row",
        height: "114px",
        justifyContent: "flex-start",
        left: 0,
        padding: "0 82px",
        position: "absolute",
        right: 0,
      },
    },
    h("img", {
      src: logo,
      width: 316,
      height: 81,
      style: { objectFit: "contain" },
    }),
  );
}

async function profileOgElement(
  input: ProfileOgImageInput,
): Promise<OgElement> {
  const [logo, avatar] = await Promise.all([
    loadBrandLogoDataUri(),
    loadImageDataUri(input.avatarUrl),
  ]);
  const bio = truncateText(input.bio, 170);
  return h(
    "div",
    {
      style: {
        width: "1200px",
        height: "630px",
        background: "#ffffff",
        color: "#111111",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "Noto Sans, Noto Sans JP, Noto Sans KR, Noto Sans SC, Noto Sans TC, Noto Emoji",
        position: "relative",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "row",
          gap: "46px",
          padding: "76px 82px 62px",
          width: "1200px",
          height: "516px",
        },
      },
      h("img", {
        src: avatar,
        width: 172,
        height: 172,
        style: {
          borderRadius: "86px",
          border: "1px solid #d4d4d4",
          objectFit: "cover",
          flexShrink: 0,
        },
      }),
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            paddingTop: "4px",
            width: "800px",
          },
        },
        h(
          "div",
          {
            style: {
              fontSize: "60px",
              fontWeight: 600,
              lineHeight: 1.16,
              letterSpacing: "0",
              maxHeight: "150px",
            },
          },
          truncateText(input.displayName, 44),
        ),
        h(
          "div",
          {
            style: {
              color: "#737373",
              fontSize: "31px",
              lineHeight: 1.25,
              marginTop: "18px",
            },
          },
          input.handle,
        ),
        h(
          "div",
          {
            style: {
              color: "#262626",
              display: bio === "" ? "none" : "flex",
              fontSize: "34px",
              lineHeight: 1.42,
              marginTop: "38px",
              maxHeight: "198px",
              whiteSpace: "pre-wrap",
            },
          },
          bio,
        ),
      ),
    ),
    brandFooter(logo),
  );
}

async function articleOgElement(
  input: ArticleOgImageInput,
): Promise<OgElement> {
  const [logo, avatar] = await Promise.all([
    loadBrandLogoDataUri(),
    loadImageDataUri(input.avatarUrl),
  ]);
  const excerpt = truncateText(input.excerpt, 132);
  return h(
    "div",
    {
      style: {
        width: "1200px",
        height: "630px",
        background: "#ffffff",
        color: "#111111",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "Noto Sans, Noto Sans JP, Noto Sans KR, Noto Sans SC, Noto Sans TC, Noto Emoji",
        position: "relative",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          padding: "68px 82px 56px",
          width: "1200px",
          height: "516px",
        },
      },
      h(
        "div",
        {
          style: {
            alignItems: "center",
            display: "flex",
            flexDirection: "row",
            gap: "22px",
            height: "92px",
          },
        },
        h("img", {
          src: avatar,
          width: 82,
          height: 82,
          style: {
            borderRadius: "41px",
            border: "1px solid #d4d4d4",
            objectFit: "cover",
            flexShrink: 0,
          },
        }),
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
            },
          },
          h(
            "div",
            {
              style: {
                fontSize: "32px",
                fontWeight: 600,
                lineHeight: 1.15,
              },
            },
            truncateText(input.authorName, 52),
          ),
          h(
            "div",
            {
              style: {
                color: "#737373",
                fontSize: "23px",
                lineHeight: 1.2,
                marginTop: "7px",
              },
            },
            input.handle,
          ),
        ),
      ),
      h(
        "div",
        {
          lang: input.language,
          style: {
            fontSize: "58px",
            fontWeight: 600,
            lineHeight: 1.22,
            letterSpacing: "0",
            marginTop: "40px",
            maxHeight: "216px",
            width: "1018px",
          },
        },
        truncateText(input.title, 78),
      ),
      h(
        "div",
        {
          lang: input.language,
          style: {
            color: "#404040",
            display: excerpt === "" ? "none" : "flex",
            fontSize: "30px",
            lineHeight: 1.42,
            marginTop: "24px",
            maxHeight: "88px",
            whiteSpace: "pre-wrap",
            width: "1018px",
          },
        },
        excerpt,
      ),
    ),
    brandFooter(logo),
  );
}

async function renderPng(element: OgElement): Promise<Uint8Array> {
  const svg = await satori(element as Parameters<typeof satori>[0], {
    ...OG_SIZE,
    fonts: await loadFonts(),
  });
  return new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: OG_SIZE.width,
    },
  }).render().asPng();
}

async function putOgImage(
  disk: Disk,
  existingKey: string | null | undefined,
  input: unknown,
  createElement: () => Promise<OgElement>,
): Promise<string> {
  const canonicalInput = canonicalize({
    version: OG_VERSION,
    size: OG_SIZE,
    input,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalInput),
  );
  const key = `${OG_NAMESPACE}/${encodeHex(digest)}.png`;
  if (existingKey === key) return key;
  const png = await renderPng(await createElement());
  await disk.put(key, png);
  return key;
}

export async function putProfileOgImage(
  disk: Disk,
  existingKey: string | null | undefined,
  input: ProfileOgImageInput,
): Promise<string> {
  const { avatarUrl: _avatarUrl, ...cacheInput } = input;
  return await putOgImage(
    disk,
    existingKey,
    { type: "profile", ...cacheInput },
    () => profileOgElement(input),
  );
}

export async function putArticleOgImage(
  disk: Disk,
  existingKey: string | null | undefined,
  input: ArticleOgImageInput,
): Promise<string> {
  const { avatarUrl: _avatarUrl, ...cacheInput } = input;
  return await putOgImage(
    disk,
    existingKey,
    { type: "article", ...cacheInput },
    () => articleOgElement(input),
  );
}

export async function renderProfileOgImageForPreview(
  input: ProfileOgImageInput,
): Promise<Uint8Array> {
  return await renderPng(await profileOgElement(input));
}

export async function renderArticleOgImageForPreview(
  input: ArticleOgImageInput,
): Promise<Uint8Array> {
  return await renderPng(await articleOgElement(input));
}

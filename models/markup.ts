import createMarkdownIt from "markdown-it";
import abbr from "markdown-it-abbr";
import { alertPlugin as admonition } from "markdown-it-github-alert";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import xss from "xss";
import { encodeBase64Url } from "@std/encoding/base64url";

const md = createMarkdownIt()
  .use(abbr)
  .use(admonition)
  .use(deflist)
  .use(footnote);
const textEncoder = new TextEncoder();

const KV_NAMESPACE = ["markup", "v2"];

export interface RenderedMarkup {
  html: string;
  text: string;
}

export async function renderMarkup(
  kv: Deno.Kv,
  markup: string,
): Promise<RenderedMarkup> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(markup)),
  );
  const key = [...KV_NAMESPACE, hash];
  const result = await kv.get<RenderedMarkup>(key);
  if (result.value != null) return result.value;
  const docId = encodeBase64Url(hash);
  const env = { docId };
  const html = md.render(markup, env);
  const text = xss(html, { whiteList: {}, stripIgnoreTag: true });
  const rendered: RenderedMarkup = { html: xss(html), text };
  await kv.set(key, rendered, { expireIn: 30 * 24 * 60 * 60 * 1000 });
  return rendered;
}

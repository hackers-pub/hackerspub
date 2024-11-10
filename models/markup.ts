import createMarkdownIt from "markdown-it";
import abbr from "markdown-it-abbr";
import { alertPlugin as admonition } from "markdown-it-github-alert";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import { encodeBase64Url } from "@std/encoding/base64url";

const md = createMarkdownIt()
  .use(abbr)
  .use(admonition)
  .use(deflist)
  .use(footnote);
const textEncoder = new TextEncoder();

const KV_NAMESPACE = ["markup", "v1"];

export interface RenderedText {
  html: string;
}

export async function renderMarkup(
  kv: Deno.Kv,
  text: string,
): Promise<RenderedText> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(text)),
  );
  const key = [...KV_NAMESPACE, hash];
  const result = await kv.get<RenderedText>(key);
  if (result.value != null) return result.value;
  const docId = encodeBase64Url(hash);
  const env = { docId };
  const html = md.render(text, env);
  const rendered: RenderedText = { html };
  await kv.set(key, rendered, { expireIn: 30 * 24 * 60 * 60 * 1000 });
  return rendered;
}

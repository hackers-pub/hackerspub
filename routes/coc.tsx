import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { page } from "fresh";
import { db } from "../db.ts";
import { kv } from "../kv.ts";
import { renderMarkup } from "../models/markup.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const coc = await Deno.readTextFile(
      join(
        dirname(import.meta.dirname!),
        `CODE_OF_CONDUCT.${ctx.state.language}.md`,
      ),
    );
    const rendered = await renderMarkup(db, ctx.state.fedCtx, coc, { kv });
    ctx.state.title = rendered.title;
    return page<CocProps>({ html: rendered.html });
  },
});

interface CocProps {
  html: string;
}

export default define.page<typeof handler, CocProps>(
  function Coc({ data: { html } }) {
    return (
      <article
        class="prose dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
);

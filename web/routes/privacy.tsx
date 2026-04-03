import { page } from "@fresh/core";
import { renderMarkup } from "@hackerspub/models/markup";
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { kv } from "../kv.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const policy = await Deno.readTextFile(
      join(
        dirname(dirname(import.meta.dirname!)),
        `PRIVACY_POLICY.${ctx.state.language}.md`,
      ),
    );
    const rendered = await renderMarkup(ctx.state.fedCtx, policy, { kv });
    ctx.state.title = rendered.title;
    return page<PrivacyProps>({ html: rendered.html });
  },
});

interface PrivacyProps {
  html: string;
}

export default define.page<typeof handler, PrivacyProps>(
  function Privacy({ data: { html } }) {
    return (
      <article
        class="prose dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
);

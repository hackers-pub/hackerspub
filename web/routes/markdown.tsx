import { page } from "@fresh/core";
import { transformMentions } from "@hackerspub/models/html";
import { renderMarkup, type Toc } from "@hackerspub/models/markup";
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { load } from "cheerio";
import { Msg } from "../components/Msg.tsx";
import { kv } from "../kv.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const markdown = await Deno.readTextFile(
      join(
        dirname(import.meta.dirname!),
        `locales/markdown/${ctx.state.language}.md`,
      ),
    );
    const rendered = await renderMarkup(ctx.state.fedCtx, markdown, { kv });
    ctx.state.title = rendered.title;
    let html = transformMentions(
      rendered.html,
      Object.values(rendered.mentions).map((actor) => ({ actor })),
      {},
    );
    const $ = load(html);
    $("h1:first-child").remove();
    html = $.html();
    return page<MarkdownGuideProps>({
      title: rendered.title,
      html,
      toc: rendered.toc[0].children,
    });
  },
});

interface TableOfContentsProps {
  toc: Toc[];
  class?: string;
}

function TableOfContents({ toc, class: cls }: TableOfContentsProps) {
  return (
    <ol class={cls}>
      {toc.map((item) => (
        <li key={item.id} class="leading-7 text-sm">
          <a
            href={`#${encodeURIComponent(item.id)}`}
          >
            {item.title}
          </a>
          {item.children.length > 0 && (
            <TableOfContents toc={item.children} class="ml-6" />
          )}
        </li>
      ))}
    </ol>
  );
}

interface MarkdownGuideProps {
  title: string;
  html: string;
  toc: Toc[];
}

export default define.page<typeof handler, MarkdownGuideProps>(
  function MarkdownGuide({ data: { title, html, toc } }) {
    return (
      <article>
        <h1 class="font-extrabold text-4xl mb-8">
          <svg
            fill="currentColor"
            height="128"
            viewBox="0 0 208 128"
            width="208"
            xmlns="http://www.w3.org/2000/svg"
            class="size-12 float-left mr-2"
            stroke="currentColor"
          >
            <g>
              <path
                clip-rule="evenodd"
                d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                fill-rule="evenodd"
              />
              <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
            </g>
          </svg>
          {title}
        </h1>
        <nav class="
          p-4 mb-8 bg-stone-100 dark:bg-stone-800 w-fit
          xl:fixed right-[calc((100%-1280px)/2)]
        ">
          <p class="
            font-bold text-sm leading-7 uppercase
            text-stone-500 dark:text-stone-400
          ">
            <Msg $key="article.tableOfContents" />
          </p>
          <TableOfContents toc={toc} />
        </nav>
        <div
          class="prose dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>
    );
  },
);

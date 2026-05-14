import { renderMarkup } from "@hackerspub/models/markup";
import { builder } from "./builder.ts";

builder.queryField("renderMarkdown", (t) =>
  t.field({
    type: "HTML",
    description: "Renders a Markdown string to HTML.",
    authScopes: { signed: true },
    args: {
      content: t.arg.string({ required: true }),
    },
    async resolve(_root, args, ctx) {
      const rendered = await renderMarkup(ctx.fedCtx, args.content);
      return rendered.html;
    },
  }));

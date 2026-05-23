import { getArticleSourceMediumUrls } from "@hackerspub/models/article";
import {
  getMissingArticleMediumLabel,
  renderMarkup,
} from "@hackerspub/models/markup";
import { builder } from "./builder.ts";
import { NotAuthorizedError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

builder.queryField("renderMarkdown", (t) =>
  t.field({
    type: "HTML",
    description:
      "Renders a Markdown string to HTML. When `articleSourceId` is " +
      "provided, `hp-medium:KEY` references in the markdown are resolved " +
      "against that article source's attached media (e.g. for previewing " +
      "edits to an existing article). Only the article's author may pass " +
      "their own `articleSourceId`; otherwise the call is rejected.",
    args: {
      content: t.arg.string({
        required: true,
        description:
          "Markdown source text to render into sanitized `HTML`. Used by " +
          "client-side previews while composing or editing posts.",
      }),
      articleSourceId: t.arg({
        type: "UUID",
        required: false,
        description:
          "UUID of an `ArticleSource` owned by the viewer. When provided, " +
          "the rendered HTML resolves `hp-medium:KEY` references against " +
          "this source's media. The missing-medium placeholder is " +
          "localized to the viewer's preferred locale.",
      }),
    },
    async resolve(_root, args, ctx) {
      let mediumUrls: Record<string, string> | undefined;
      let missingMediumLabel: string | undefined;
      if (args.articleSourceId != null) {
        const session = await ctx.session;
        if (session == null) throw new NotAuthenticatedError();
        const source = await ctx.db.query.articleSourceTable.findFirst({
          where: { id: args.articleSourceId },
          columns: { id: true, accountId: true },
        });
        if (source == null || source.accountId !== session.accountId) {
          throw new NotAuthorizedError();
        }
        mediumUrls = await getArticleSourceMediumUrls(
          ctx.db,
          ctx.disk,
          source.id,
        );
        missingMediumLabel = getMissingArticleMediumLabel(
          ctx.account?.locales?.[0],
        );
      }
      const rendered = await renderMarkup(ctx.fedCtx, args.content, {
        mediumUrls,
        missingMediumLabel,
      });
      return rendered.html;
    },
  }));

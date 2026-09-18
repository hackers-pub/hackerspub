import { Account } from "../account.ts";
import { builder } from "../builder.ts";
import { ArticleDraft } from "./article.ts";

builder.drizzleObjectField(Account, "articleDrafts", (t) =>
  t.relatedConnection("articleDrafts", {
    type: ArticleDraft,
    description:
      "Unpublished article drafts owned by this workspace account, most " +
      "recently updated first. This is the account's own personal drafts or, " +
      "for an organization, the drafts shared with its accepted members. " +
      "Visible only to the account holder and accepted organization members.",
    authScopes: (parent) => ({
      canActAsAccount: "id" in parent ? parent.id : undefined,
    }),
    query: () => ({
      orderBy: { updated: "desc" },
    }),
  }),
);

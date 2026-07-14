import { Account } from "../account.ts";
import { builder } from "../builder.ts";
import { ArticleDraft } from "./article.ts";

builder.drizzleObjectField(
  Account,
  "articleDrafts",
  (t) =>
    t.relatedConnection("articleDrafts", {
      type: ArticleDraft,
      description:
        "Unpublished article drafts belonging to this account, most " +
        "recently updated first. Only visible to the account holder.",
      authScopes: (parent) => ({
        selfAccount: "id" in parent ? parent.id : undefined,
      }),
      query: () => ({
        orderBy: { updated: "desc" },
      }),
    }),
);

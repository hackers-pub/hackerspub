import { desc, eq } from "drizzle-orm";
import { page } from "fresh";
import { define } from "../../../utils.ts";
import {
  type Account,
  accountTable,
  type ArticleDraft,
  articleDraftTable,
} from "../../../models/schema.ts";
import { db } from "../../../db.ts";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { ConfirmForm } from "../../../islands/ConfirmForm.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      with: {
        articleDrafts: {
          orderBy: [
            desc(articleDraftTable.updated),
            desc(articleDraftTable.created),
          ],
        },
      },
      where: eq(accountTable.id, ctx.state.session.accountId),
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    return page<DraftsPageProps>({
      account: account,
      drafts: account.articleDrafts,
    });
  },
});

interface DraftsPageProps {
  account: Account;
  drafts: ArticleDraft[];
}

export default define.page<typeof handler, DraftsPageProps>(
  function DraftsPage({ data: { account, drafts } }) {
    return (
      <div>
        <PageTitle>Article drafts</PageTitle>
        {drafts.map((draft) => (
          <article key={draft.id} class="mb-4 flex gap-4">
            <div class="grow leading-7 p-4 bg-stone-100 dark:bg-stone-800 has-[:link:hover]:bg-stone-200 dark:has-[:link:hover]:bg-stone-700">
              <h2 class="text-xl font-bold text-ellipsis">
                <a href={`/@${account.username}/drafts/${draft.id}`}>
                  {draft.title === ""
                    ? <span class="italic">(No title)</span>
                    : draft.title}
                </a>
              </h2>
              <p class="opacity-50 text-ellipsis">
                <a href={`/@${account.username}/drafts/${draft.id}`}>
                  Created at{" "}
                  <time datetime={draft.created.toISOString()}>
                    {draft.created.toLocaleString("en-US", {
                      dateStyle: "full",
                      timeStyle: "short",
                    })}
                  </time>
                  {+draft.created !== +draft.updated &&
                    (
                      <>
                        {" "}
                        &middot; Updated at{" "}
                        <time datetime={draft.updated.toISOString()}>
                          {draft.updated.toLocaleString("en-US", {
                            dateStyle: "full",
                            timeStyle: "short",
                          })}
                        </time>
                      </>
                    )}
                </a>
              </p>
              <p class="text-ellipsis">
                <a href={`/@${account.username}/drafts/${draft.id}`}>
                  {draft.content}
                </a>
              </p>
            </div>
            <ConfirmForm
              method="post"
              action={`/@${account.username}/drafts/${draft.id}/delete`}
              confirm="Are you sure you want to delete this draft?"
            >
              <button
                type="submit"
                class="h-full p-4 bg-stone-100 dark:bg-stone-800 :hover:bg-stone-200 dark:hover:bg-stone-700"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="size-6"
                  aria-label="Delete draft"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                  />
                </svg>
              </button>
            </ConfirmForm>
          </article>
        ))}
      </div>
    );
  },
);

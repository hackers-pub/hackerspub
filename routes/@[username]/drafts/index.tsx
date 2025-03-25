import { desc } from "drizzle-orm";
import { page } from "fresh";
import { Excerpt } from "../../../components/Excerpt.tsx";
import { Msg } from "../../../components/Msg.tsx";
import { PageTitle } from "../../../components/PageTitle.tsx";
import { db } from "../../../db.ts";
import { ConfirmForm } from "../../../islands/ConfirmForm.tsx";
import { Timestamp } from "../../../islands/Timestamp.tsx";
import { renderMarkup } from "../../../models/markup.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      with: {
        articleDrafts: {
          orderBy: (t) => [desc(t.updated), desc(t.created)],
        },
      },
      where: { id: ctx.state.session.accountId },
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    return page<DraftsPageProps>({
      drafts: await Promise.all(account.articleDrafts.map(async (draft) => ({
        url: `/@${account.username}/drafts/${draft.id}`,
        deleteUrl: `/@${account.username}/drafts/${draft.id}/delete`,
        title: draft.title,
        created: draft.created,
        updated: draft.updated,
        excerptHtml:
          (await renderMarkup(db, ctx.state.fedCtx, draft.id, draft.content))
            .excerptHtml,
      }))),
    });
  },
});

interface DraftsPageProps {
  drafts: {
    url: string;
    deleteUrl: string;
    title: string;
    created: Date;
    updated: Date;
    excerptHtml: string;
  }[];
}

export default define.page<typeof handler, DraftsPageProps>(
  function DraftsPage({ state: { t, language }, data: { drafts } }) {
    return (
      <div>
        <PageTitle>
          <Msg $key="articleDrafts.title" />
        </PageTitle>
        {drafts.map((draft) => (
          <article key={draft.url} class="mb-4 flex gap-4">
            <a
              href={draft.url}
              class="grow block bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700"
            >
              <div class="leading-7 p-4">
                <h2 class="text-xl font-bold truncate">
                  {draft.title === ""
                    ? (
                      <span class="italic">
                        <Msg $key="articleDrafts.noTitle" />
                      </span>
                    )
                    : draft.title}
                </h2>
                <p class="text-stone-500 dark:text-stone-400 truncate">
                  <Msg
                    $key="articleDrafts.created"
                    created={
                      <Timestamp value={draft.created} locale={language} />
                    }
                  />
                  {+draft.created !== +draft.updated &&
                    (
                      <>
                        {" "}
                        &middot;{" "}
                        <Msg
                          $key="articleDrafts.updated"
                          updated={
                            <Timestamp
                              value={draft.updated}
                              locale={language}
                            />
                          }
                        />
                      </>
                    )}
                </p>
                <Excerpt
                  html={draft.excerptHtml}
                  class="max-w-[calc(1280px-7rem-24px)]"
                />
              </div>
            </a>
            <ConfirmForm
              method="post"
              action={draft.deleteUrl}
              confirm={t("articleDrafts.deleteConfirm")}
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
                  aria-label={t("articleDrafts.delete")}
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

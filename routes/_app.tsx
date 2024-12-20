import { count, eq } from "drizzle-orm";
import type { PageProps } from "fresh";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { db } from "../db.ts";
import { getAvatarUrl } from "../models/account.ts";
import {
  type Account,
  type AccountEmail,
  accountTable,
  articleDraftTable,
} from "../models/schema.ts";
import { State } from "../utils.ts";

const PLAUSIBLE = Deno.env.get("PLAUSIBLE")?.trim()?.toLowerCase() === "true";

export default async function App(
  { Component, state, url }: PageProps<unknown, State>,
) {
  let account: Account & { emails: AccountEmail[] } | undefined = undefined;
  let drafts = 0;
  let avatarUrl: string | undefined = undefined;
  if (state.session != null) {
    account = await db.query.accountTable.findFirst({
      with: { emails: true },
      where: eq(accountTable.id, state.session.accountId),
    });
    drafts = (await db.select({ cnt: count() })
      .from(articleDraftTable)
      .where(eq(articleDraftTable.accountId, state.session.accountId)))[0].cnt;
    avatarUrl = account == null ? undefined : await getAvatarUrl(account);
  }
  return (
    <TranslationSetup language={state.language}>
      <html lang={state.language}>
        <head>
          <meta charset="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          {state.metas.map((meta) => (
            "property" in meta
              ? (
                <meta
                  property={meta.property}
                  content={meta.content.toString()}
                />
              )
              : <meta name={meta.name} content={meta.content.toString()} />
          ))}
          <title>{state.title}</title>
          <link rel="stylesheet" href="/styles.css" />
          {state.links.map((link) => (
            <link
              rel={link.rel}
              href={link.href.toString()}
              hreflang={link.hreflang}
              type={link.type}
            />
          ))}
          {PLAUSIBLE && (
            <script
              defer={true}
              data-domain={url.host}
              src="https://plausible.io/js/script.outbound-links.js"
            />
          )}
        </head>
        <body class="font-sans dark:bg-stone-900 dark:text-white">
          <header class="h-[60px] bg-black text-gray-300 dark:bg-stone-100 dark:text-stone-700">
            <nav class="m-auto max-w-screen-xl p-4 text-xl flex flex-row">
              <a
                href="/"
                class="basis-1/2 text-white dark:text-black font-bold"
              >
                Hackers’ Pub
              </a>
              <div class="group basis-1/2 text-right">
                {account == null
                  ? (
                    <a href="/sign">
                      <Msg $key="nav.signInUp" />
                    </a>
                  )
                  : (
                    <>
                      <div class="flex flex-row-reverse cursor-default">
                        <img
                          src={avatarUrl}
                          width={28}
                          height={28}
                          class="grow-0 order-last mr-4"
                        />
                        <a href={`/@${account.username}`}>
                          <strong>{account.name}</strong>
                        </a>
                      </div>
                      <div class="
                          hidden group-hover:flex
                          absolute right-[calc((100%-1280px)/2)]
                          max-w-screen-sm w-1/6 p-4 pt-8
                          bg-black dark:bg-stone-100
                          flex-col gap-4
                        ">
                        <a href={`/@${account.username}/drafts/new`}>
                          <Msg $key="nav.newArticle" />
                        </a>
                        {drafts > 0 && (
                          <a href={`/@${account.username}/drafts`}>
                            <Msg $key="nav.drafts" />{" "}
                            <span class="opacity-50">({drafts})</span>
                          </a>
                        )}
                        <a href={`/@${account.username}/settings`}>
                          <Msg $key="nav.settings" />
                        </a>
                        <form
                          method="post"
                          action="/sign/out"
                        >
                          <input type="hidden" name="next" value={url.href} />
                          <button type="submit">
                            <Msg $key="nav.signOut" />
                          </button>
                        </form>
                      </div>
                    </>
                  )}
              </div>
            </nav>
          </header>
          {state.withoutMain ? <Component /> : (
            <>
              <main class="m-auto max-w-screen-xl min-h-[calc(100vh_-_120px)] p-4">
                <Component />
              </main>
              <footer class="left-0 w-full h-[60px] bg-stone-100 dark:bg-stone-800">
                <nav class="m-auto max-w-screen-xl p-4 pb-5 text-stone-400">
                  <a href="/coc" class="text-black dark:text-white underline">
                    <Msg $key="nav.coc" />
                  </a>{" "}
                  &middot;{" "}
                  <span class="text-black dark:text-white">
                    <Msg
                      $key="nav.openSource"
                      repository={
                        <a
                          href="https://github.com/dahlia/hackerspub"
                          class="underline"
                        >
                          <Msg $key="nav.githubRepository" />
                        </a>
                      }
                      license={
                        <a
                          href="https://www.gnu.org/licenses/agpl-3.0.html"
                          class="underline"
                        >
                          AGPL 3.0
                        </a>
                      }
                    />
                  </span>
                </nav>
              </footer>
            </>
          )}
        </body>
      </html>
    </TranslationSetup>
  );
}

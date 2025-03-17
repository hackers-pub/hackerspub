import { count, eq } from "drizzle-orm";
import type { PageProps } from "fresh";
import { Msg, Translation, TranslationSetup } from "../components/Msg.tsx";
import { db } from "../db.ts";
import { getAvatarUrl } from "../models/account.ts";
import {
  type Account,
  type AccountEmail,
  accountTable,
  articleDraftTable,
} from "../models/schema.ts";
import type { State } from "../utils.ts";

const MODE = Deno.env.get("MODE") ?? "production";
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
      <Translation>
        {(t) => (
          <html lang={state.language} prefix="og: https://ogp.me/ns#">
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
              <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
              <link
                rel="alternate icon"
                type="image/x-icon"
                href="/favicon.ico"
                sizes="16x16 32x32 48x48 256x256"
              />
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
                  defer
                  data-domain={url.host}
                  src="https://plausible.io/js/script.outbound-links.js"
                />
              )}
            </head>
            <body
              class={`font-sans dark:bg-stone-900 dark:text-white ${
                MODE === "development"
                  ? "bg-[url(/dev-bg-light.svg)] dark:bg-[url(/dev-bg-dark.svg)]"
                  : ""
              }`}
            >
              <header class="h-[60px] bg-black text-gray-300 dark:bg-stone-100 dark:text-stone-700">
                <nav class="m-auto xl:max-w-screen-xl text-xl flex flex-row gap-4">
                  <a
                    href="/"
                    class="grow-0 lg:basis-1/3 p-4 text-white dark:text-black font-bold"
                  >
                    Hackers’ Pub
                  </a>
                  <form
                    method="get"
                    action="/search"
                    class="hidden lg:block lg:basis-1/3"
                  >
                    <input
                      type="search"
                      name="query"
                      placeholder={t("nav.search")}
                      value={state.searchQuery}
                      class="w-full h-[calc(100%-2px)] bg-black text-gray-300 dark:bg-stone-100 dark:text-stone-700 border-none text-center"
                    />
                  </form>
                  <div class="grow lg:basis-1/3 text-right">
                    {account == null
                      ? (
                        <div class="flex flex-row-reverse">
                          <a href="/sign" class="block grow-0 p-4">
                            <Msg $key="nav.signInUp" />
                          </a>
                        </div>
                      )
                      : (
                        <>
                          <div class="flex flex-row-reverse">
                            <div class="
                              group block
                              w-[calc(30px+2rem)] h-[calc(30px+2rem)] p-4
                            ">
                              <img
                                src={avatarUrl}
                                width={30}
                                height={30}
                              />
                              <div class="
                                hidden group-hover:flex group-active:flex
                                absolute z-50
                                right-0 xl:right-[calc((100%-1280px)/2)]
                                max-w-screen-md mt-2 p-4
                                bg-stone-200 dark:bg-stone-700
                                border border-stone-400 dark:border-stone-500
                                text-stone-800 dark:text-stone-100
                                flex-col gap-4
                              ">
                                <a
                                  href={`/@${account.username}`}
                                  class="flex flex-row-reverse gap-4"
                                >
                                  <strong class="block truncate">
                                    {account.name}
                                  </strong>
                                  <img
                                    src={avatarUrl}
                                    width={30}
                                    height={30}
                                    class="block"
                                  />
                                </a>
                                <a href={`/@${account.username}/settings`}>
                                  <Msg $key="nav.settings" />
                                </a>
                                {account.moderator && (
                                  <a href="/admin">
                                    Admin
                                  </a>
                                )}
                                <form
                                  method="post"
                                  action="/sign/out"
                                >
                                  <input
                                    type="hidden"
                                    name="next"
                                    value={url.href}
                                  />
                                  <button type="submit">
                                    <Msg $key="nav.signOut" />
                                  </button>
                                </form>
                              </div>
                            </div>
                            <a
                              href={`/@${account.username}/drafts/new`}
                              title={t("nav.newArticle")}
                              class="block grow-0 py-4 px-2"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={1.5}
                                stroke="currentColor"
                                aria-label={t("nav.newArticle")}
                                className="size-[30px]"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
                                />
                              </svg>
                            </a>
                            {drafts > 0 && (
                              <a
                                href={`/@${account.username}/drafts`}
                                title={`${t("nav.drafts")} (${drafts})`}
                                class="block grow-0 py-4 px-2"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  strokeWidth={1.5}
                                  stroke="currentColor"
                                  aria-label={`${t("nav.drafts")} (${drafts})`}
                                  className="size-[30px]"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="m 20.25,7.5 -0.625,10.632 c -0.06991,1.189655 -1.055292,2.118464 -2.247,2.118 H 6.622 C 5.4302924,20.250464 4.4449134,19.321655 4.375,18.132 L 3.75,7.5 m -0.375,0 h 17.25 c 0.621,0 1.125,-0.504 1.125,-1.125 v -1.5 C 21.75,4.254 21.246,3.75 20.625,3.75 H 3.375 C 2.754,3.75 2.25,4.254 2.25,4.875 v 1.5 C 2.25,6.996 2.754,7.5 3.375,7.5 Z"
                                  />
                                  <text
                                    style="font-size:8px;text-align:center;text-anchor:middle"
                                    stroke="none"
                                    fill="currentColor"
                                    x="12.016002"
                                    y="16.292"
                                  >
                                    <tspan
                                      x="12.016002"
                                      y="16.292"
                                      style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:8px;font-family:sans-serif;"
                                      stroke="none"
                                      fill="currentColor"
                                    >
                                      {drafts}
                                    </tspan>
                                  </text>
                                </svg>
                              </a>
                            )}
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
                  <footer class="left-0 w-full min-h-[60px] bg-stone-100 dark:bg-stone-800">
                    <nav class="m-auto max-w-screen-xl p-4 pb-5 text-stone-400">
                      <a
                        href="/coc"
                        class="text-black dark:text-white underline"
                      >
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
        )}
      </Translation>
    </TranslationSetup>
  );
}

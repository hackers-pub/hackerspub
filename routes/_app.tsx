import { eq } from "drizzle-orm";
import type { PageProps } from "fresh";
import { State } from "../utils.ts";
import { db } from "../db.ts";
import { accountTable } from "../models/schema.ts";

export default async function App(
  { Component, state, url }: PageProps<unknown, State>,
) {
  const account = state.session == null
    ? null
    : await db.query.accountTable.findFirst({
      where: eq(accountTable.id, state.session.accountId),
    });
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
      </head>
      <body class="font-sans dark:bg-stone-900 dark:text-white">
        <header class="bg-black text-gray-300 dark:bg-stone-100 dark:text-stone-700">
          <nav class="m-auto max-w-screen-xl p-4 text-xl flex flex-row">
            <a href="/" class="basis-3/4 text-white dark:text-black font-bold">
              Hackers’ Pub
            </a>
            <div class="group basis-1/4 text-right">
              {account == null ? <a href="/sign">Sign in/up</a> : (
                <>
                  <strong>{account.name}</strong>
                  <div class="
                    hidden group-hover:flex
                    absolute right-[calc((100%-1280px)/2)]
                    max-w-screen-sm w-1/6 p-4 pt-8
                    bg-black dark:bg-stone-100
                    flex-col gap-4
                  ">
                    <a href={`/@${account.username}/drafts/new`}>New article</a>
                    <a href={`/@${account.username}`}>Profile</a>
                    <a href={`/@${account.username}/settings`}>Settings</a>
                    <form
                      method="post"
                      action="/sign/out"
                    >
                      <input type="hidden" name="next" value={url.href} />
                      <button type="submit">Sign out</button>
                    </form>
                  </div>
                </>
              )}
            </div>
          </nav>
        </header>
        {state.withoutMain
          ? <Component />
          : (
            <main class="m-auto max-w-screen-xl p-4">
              <Component />
            </main>
          )}
      </body>
    </html>
  );
}

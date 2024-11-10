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
            <a href="/" class="basis-1/2 text-white dark:text-black font-bold">
              Hackers' Pub
            </a>
            {account == null
              ? (
                <div class="basis-1/2 text-right">
                  <a href="/sign">Sign in/up</a>
                </div>
              )
              : (
                <form
                  method="post"
                  action="/sign/out"
                  class="basis-1/2 text-right"
                >
                  <a href={`/@${account.username}`}>
                    <strong>{account.name}</strong>
                  </a>{" "}
                  &middot; <input type="hidden" name="next" value={url.href} />
                  <button type="submit">Sign out</button>
                </form>
              )}
          </nav>
        </header>
        <main class="m-auto max-w-screen-xl p-4">
          <Component />
        </main>
      </body>
    </html>
  );
}

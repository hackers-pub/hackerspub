import { isActor } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, desc, eq } from "drizzle-orm";
import { page } from "fresh";
import { Excerpt } from "../../components/Excerpt.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import {
  type AccountLink,
  accountLinkTable,
  accountTable,
  actorTable,
  articleSourceTable,
} from "../../models/schema.ts";
import { htmlXss, renderMarkup } from "../../models/markup.ts";
import { compactUrl, define } from "../../utils.ts";
import { persistActor } from "../../models/actor.ts";
import { getAvatarUrl } from "../../models/account.ts";
import { ArticleMetadata } from "../../components/ArticleMetadata.tsx";

const logger = getLogger(["hackerspub", "routes", "@[username]"]);

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
      return Response.redirect(
        new URL(`/@${ctx.params.username.replace(/@.*$/, "")}`, ctx.url),
        301,
      );
    } else if (ctx.params.username.includes("@")) {
      const username = ctx.params.username.replace(/@.*$/, "");
      const host = ctx.params.username.substring(
        ctx.params.username.indexOf("@") + 1,
      );
      let actor = await db.query.actorTable.findFirst({
        where: and(
          eq(actorTable.username, username),
          eq(actorTable.instanceHost, host),
        ),
      });
      if (actor == null) {
        let apActor: vocab.Object | null;
        try {
          apActor = await ctx.state.fedCtx.lookupObject(ctx.params.username);
        } catch (error) {
          logger.warn(
            "An error occurred while looking up the actor {handle}: {error}",
            { handle: ctx.params.username, error },
          );
          return ctx.next();
        }
        if (!isActor(apActor)) return ctx.next();
        actor = await persistActor(db, apActor);
        if (actor == null) return ctx.next();
      }
      if (ctx.state.session == null) {
        return ctx.redirect(actor.url ?? actor.iri);
      }
      const handle = `@${actor.username}@${actor.instanceHost}`;
      const name = actor.name ?? handle;
      ctx.state.title = name;
      return page<ProfilePageProps>({
        handle,
        name,
        avatarUrl: actor.avatarUrl ?? undefined,
        bioHtml: htmlXss.process(actor.bioHtml ?? ""),
        links: actor.fieldHtmls,
      });
    }
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: {
        emails: true,
        links: { orderBy: accountLinkTable.index },
      },
    });
    if (account == null) return ctx.next();
    const bio = await renderMarkup(account.id, account.bio);
    ctx.state.metas.push(
      {
        name: "description",
        content: bio.text,
      },
      { property: "og:title", content: account.name },
      {
        property: "og:description",
        content: bio.text,
      },
      {
        property: "og:url",
        content: new URL(`/@${account.username}`, ctx.url),
      },
      { property: "og:type", content: "profile" },
      {
        property: "og:image",
        content: new URL(`/@${account.username}/og`, ctx.url),
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
      { property: "profile:username", content: account.username },
    );
    const actorUri = ctx.state.fedCtx.getActorUri(account.id);
    ctx.state.links.push(
      {
        rel: "canonical",
        href: new URL(`/@${account.username}`, ctx.url),
      },
      {
        rel: "alternate",
        type: "application/activity+json",
        href: actorUri.href,
      },
    );
    ctx.state.title = account.name;
    const articles = await db.query.articleSourceTable.findMany({
      with: {
        account: { with: { emails: true } },
      },
      where: eq(articleSourceTable.accountId, account.id),
      orderBy: desc(articleSourceTable.published),
    });
    return page<ProfilePageProps>({
      handle: `@${account.username}@${ctx.url.host}`,
      name: account.name,
      avatarUrl: await getAvatarUrl(account),
      bioHtml: bio.html,
      links: account.links,
      articles: await Promise.all(articles.map(async (article) => ({
        title: article.title,
        url:
          `/@${account.username}/${article.published.getFullYear()}/${article.slug}`,
        excerptHtml:
          (await renderMarkup(article.id, article.content)).excerptHtml,
        author: {
          name: article.account.name,
          handle: `@${article.account.username}@${ctx.url.host}`,
          url: `/@${article.account.username}`,
          avatarUrl: await getAvatarUrl(article.account),
        },
        published: article.published,
        updated: article.updated,
      }))),
    }, {
      headers: {
        Link:
          `<${actorUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },
});

interface ProfilePageProps {
  handle: string;
  name: string;
  bioHtml: string;
  avatarUrl?: string;
  links: AccountLink[] | Record<string, string>;
  articles?: {
    title: string;
    url: string;
    excerptHtml: string;
    author: {
      name: string;
      handle: string;
      url: string;
      avatarUrl?: string;
    };
    published: Date;
    updated: Date;
  }[];
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ data }) {
    return (
      <div>
        <div class="flex">
          {data.avatarUrl && (
            <img
              src={data.avatarUrl}
              width={56}
              height={56}
              class="mb-5 mr-4"
            />
          )}
          <PageTitle subtitle={{ text: data.handle, class: "select-all" }}>
            {data.name}
          </PageTitle>
        </div>
        <div
          class="prose dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: data.bioHtml }}
        />
        {Array.isArray(data.links) && data.links.length > 0 && (
          <dl class="mt-5 flex flex-wrap gap-y-3">
            {data.links.map((link) => (
              <>
                <dt
                  key={`dt-${link.index}`}
                  class={`
                    opacity-50 mr-1
                    flex flex-row
                    ${link.index > 0 ? "before:content-['·']" : ""}
                  `}
                >
                  <img
                    src={`/icons/${link.icon}.svg`}
                    alt=""
                    width={20}
                    height={20}
                    class={`dark:invert block mr-1 ${
                      link.index > 0 ? "ml-2" : ""
                    }`}
                  />
                  <span class="block after:content-[':']">{link.name}</span>
                </dt>
                <dd key={`dd-${link.index}`} class="mr-2">
                  <a href={link.url}>
                    {link.handle ?? compactUrl(link.url)}
                  </a>
                </dd>
              </>
            ))}
          </dl>
        )}
        {!Array.isArray(data.links) && Object.keys(data.links).length > 0 && (
          <dl class="mt-5 flex flex-wrap gap-y-3">
            {Object.entries(data.links).map(([name, html], i) => (
              <>
                <dt
                  key={`dt-${i}`}
                  class={`
                    opacity-50 mr-1
                    ${i > 0 ? "before:content-['·']" : ""}
                    after:content-[':']
                  `}
                >
                  <span class={i > 0 ? "ml-2" : ""}>{name}</span>
                </dt>
                <dd
                  key={`dd-${i}`}
                  class="mr-2"
                  dangerouslySetInnerHTML={{ __html: htmlXss.process(html) }}
                >
                </dd>
              </>
            ))}
          </dl>
        )}
        <div>
          {data.articles?.map((article) => (
            <article class="mt-5 border-l-4 border-l-stone-400 dark:border-l-stone-600 pl-4">
              <h2 class="text-3xl font-bold">
                <a href={article.url}>{article.title}</a>
              </h2>
              <ArticleMetadata
                class="mt-2 mb-2"
                authorUrl={article.author.url}
                authorName={article.author.name}
                authorHandle={article.author.handle}
                authorAvatarUrl={article.author.avatarUrl}
                published={article.published}
              />
              <a href={article.url}>
                <Excerpt html={article.excerptHtml} />
              </a>
            </article>
          ))}
        </div>
      </div>
    );
  },
);

import { isActor } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";
import { page } from "fresh";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import {
  type AccountLink,
  accountLinkTable,
  accountTable,
  actorTable,
} from "../../models/schema.ts";
import { renderMarkup, xss } from "../../models/markup.ts";
import { compactUrl, define } from "../../utils.ts";
import { persistActor } from "../../models/actor.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]"]);

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
      return Response.redirect(
        new URL(`/@${ctx.params.username.replace(/@.*$/, "")}`, ctx.url),
        301,
      );
    } else if (ctx.params.username.includes("@")) {
      if (ctx.state.session == null) return ctx.next();
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
      const handle = `@${actor.username}@${actor.instanceHost}`;
      const name = actor.name ?? handle;
      ctx.state.title = name;
      return page<ProfilePageProps>({
        handle,
        name,
        bioHtml: xss.process(actor.bioHtml ?? ""),
        links: actor.fieldHtmls,
      });
    }
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: {
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
    return page<ProfilePageProps>({
      handle: `@${account.username}@${ctx.url.host}`,
      name: account.name,
      bioHtml: bio.html,
      links: account.links,
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
  links: AccountLink[] | Record<string, string>;
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ data }) {
    return (
      <div>
        <PageTitle subtitle={{ text: data.handle, class: "select-all" }}>
          {data.name}
        </PageTitle>
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
                  dangerouslySetInnerHTML={{ __html: xss.process(html) }}
                >
                </dd>
              </>
            ))}
          </dl>
        )}
      </div>
    );
  },
);

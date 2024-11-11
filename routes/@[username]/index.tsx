import { eq } from "drizzle-orm";
import { page } from "fresh";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import {
  Account,
  AccountLink,
  accountLinkTable,
  accountTable,
} from "../../models/schema.ts";
import { type RenderedMarkup, renderMarkup } from "../../models/markup.ts";
import { kv } from "../../kv.ts";
import { compactUrl, define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: {
        links: { orderBy: accountLinkTable.index },
      },
    });
    if (account == null) return ctx.next();
    const bio = await renderMarkup(kv, account.bio);
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
    return page<ProfilePageProps>({ account, actorUri, bio }, {
      headers: {
        Link:
          `<${actorUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },
});

interface ProfilePageProps {
  account: Account & { links: AccountLink[] };
  actorUri: URL;
  bio: RenderedMarkup;
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ data, url }) {
    return (
      <div>
        <PageTitle
          subtitle={{
            text: `@${data.account.username}@${url.host}`,
            class: "select-all",
          }}
        >
          {data.account.name}
        </PageTitle>
        <div
          class="prose dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: data.bio.html }}
        />
        {data.account.links.length > 0 && (
          <dl class="mt-5 flex flex-wrap gap-y-3">
            {data.account.links.map((link) => (
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
      </div>
    );
  },
);

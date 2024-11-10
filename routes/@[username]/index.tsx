import { eq } from "drizzle-orm";
import { page } from "fresh";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { Account, accountTable } from "../../models/schema.ts";
import { renderMarkup } from "../../models/markup.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account == null) return ctx.next();
    ctx.state.metas.push(
      {
        name: "description",
        content: account.bio, // TODO: Render Markdown to plain text
      },
      { property: "og:title", content: account.name },
      {
        property: "og:description",
        content: account.bio, // TODO: Render Markdown to plain text
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
    const { html: bioHtml } = await renderMarkup(kv, account.bio);
    return page<ProfilePageProps>({ account, actorUri, bioHtml }, {
      headers: {
        Link:
          `<${actorUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },
});

interface ProfilePageProps {
  account: Account;
  actorUri: URL;
  bioHtml: string;
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
          dangerouslySetInnerHTML={{ __html: data.bioHtml }}
        />
      </div>
    );
  },
);

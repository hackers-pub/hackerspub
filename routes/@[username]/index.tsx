import { isActor } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import * as v from "@valibot/valibot";
import { and, desc, eq } from "drizzle-orm";
import { page } from "fresh";
import { Button } from "../../components/Button.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { db } from "../../db.ts";
import {
  type AccountLink,
  accountLinkTable,
  accountTable,
  type Actor,
  actorTable,
  type Post,
  POST_VISIBILITIES,
  postTable,
} from "../../models/schema.ts";
import { htmlXss, renderMarkup } from "../../models/markup.ts";
import { persistActor } from "../../models/actor.ts";
import { getAvatarUrl } from "../../models/account.ts";
import { FollowingState, getFollowingState } from "../../models/following.ts";
import { compactUrl, define } from "../../utils.ts";
import { POSSIBLE_LANGUAGES } from "../../i18n.ts";
import { createNote } from "../../models/note.ts";
import { kv } from "../../kv.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]"]);

const NoteSourceSchema = v.object({
  content: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  language: v.picklist(POSSIBLE_LANGUAGES),
  visibility: v.picklist(POST_VISIBILITIES),
});

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
          apActor = await ctx.state.fedCtx.lookupObject(
            ctx.params.username,
            {
              documentLoader: ctx.state.account == null
                ? undefined
                : await ctx.state.fedCtx.getDocumentLoader({
                  identifier: ctx.state.account.id,
                }),
            },
          );
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
      let followState: FollowStateProps;
      if (ctx.state.account == null) {
        followState = {
          followedState: undefined,
          followingState: undefined,
        };
      } else {
        followState = {
          followingState: await getFollowingState(
            db,
            ctx.state.account.actor,
            actor,
          ),
          followedState: await getFollowingState(
            db,
            actor,
            ctx.state.account.actor,
          ),
          followUrl: `/${handle}/follow`,
          unfollowUrl: `/${handle}/unfollow`,
        };
      }
      const posts = await db.query.postTable.findMany({
        with: { actor: true },
        where: eq(postTable.actorId, actor.id),
        orderBy: desc(postTable.published),
      });
      ctx.state.title = name;
      return page<ProfilePageProps>({
        handle,
        name,
        avatarUrl: actor.avatarUrl ?? undefined,
        followeesCount: actor.followeesCount,
        followersCount: actor.followersCount,
        bioHtml: htmlXss.process(actor.bioHtml ?? ""),
        links: actor.fieldHtmls,
        ...followState,
        posts,
      });
    }
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
      with: {
        actor: true,
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
        href: actorUri,
      },
    );
    ctx.state.title = account.name;
    const posts = await db.query.postTable.findMany({
      with: { actor: true },
      where: eq(postTable.actorId, account.actor.id),
      orderBy: desc(postTable.published),
    });
    let followState: FollowStateProps;
    if (ctx.state.account == null || ctx.state.account.id === account.id) {
      followState = {
        followedState: undefined,
        followingState: undefined,
      };
    } else {
      followState = {
        followingState: await getFollowingState(
          db,
          ctx.state.account.actor,
          account.actor,
        ),
        followedState: await getFollowingState(
          db,
          account.actor,
          ctx.state.account.actor,
        ),
        followUrl: `/@${account.username}/follow`,
        unfollowUrl: `/@${account.username}/unfollow`,
      };
    }
    return page<ProfilePageProps>({
      handle: `@${account.username}@${ctx.url.host}`,
      name: account.name,
      avatarUrl: await getAvatarUrl(account),
      followeesCount: account.actor.followeesCount,
      followersCount: account.actor.followersCount,
      bioHtml: bio.html,
      links: account.links,
      ...followState,
      posts,
    }, {
      headers: {
        Link:
          `<${actorUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    if (ctx.state.account?.username !== ctx.params.username) {
      return new Response("Forbidden", { status: 403 });
    }
    const payload = await ctx.req.json();
    const parsed = await v.safeParseAsync(NoteSourceSchema, payload);
    if (!parsed.success) {
      return new Response(JSON.stringify(parsed.issues), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const post = await createNote(db, kv, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    });
    if (post == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

type ProfilePageProps = {
  handle: string;
  name: string;
  bioHtml: string;
  followeesCount: number;
  followersCount: number;
  avatarUrl?: string;
  links: AccountLink[] | Record<string, string>;
  posts: (Post & { actor: Actor })[];
} & FollowStateProps;

type FollowStateProps = {
  followingState: FollowingState;
  followedState: FollowingState;
  followUrl: string;
  unfollowUrl: string;
} | {
  followingState: undefined;
  followedState: undefined;
};

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
          <PageTitle
            subtitle={{
              text: (
                <>
                  <span class="select-all">{data.handle}</span> &middot;{" "}
                  <Msg
                    $key="profile.followeesCount"
                    count={data.followeesCount}
                  />{" "}
                  &middot;{" "}
                  <Msg
                    $key="profile.followersCount"
                    count={data.followersCount}
                  />
                </>
              ),
            }}
          >
            {data.name}
          </PageTitle>
          {data.followingState === "none"
            ? (
              <form method="post" action={data.followUrl}>
                <Button class="ml-4 mt-2 h-9">
                  <Msg $key="profile.follow" />
                </Button>
              </form>
            )
            : data.followingState != null &&
              (
                <form method="post" action={data.unfollowUrl}>
                  <Button class="ml-4 mt-2 h-9">
                    {data.followingState === "following"
                      ? <Msg $key="profile.unfollow" />
                      : <Msg $key="profile.cancelRequest" />}
                  </Button>
                </form>
              )}
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
          {data.posts.map((post) => <PostExcerpt post={post} />)}
        </div>
      </div>
    );
  },
);

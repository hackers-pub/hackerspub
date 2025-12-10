import { page } from "@fresh/core";
import { recommendActors } from "@hackerspub/models/actor";
import { extractMentionsFromHtml } from "@hackerspub/models/markup";
import type {
  Account,
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import {
  getPersonalTimeline,
  getPublicTimeline,
  type TimelineEntry,
} from "@hackerspub/models/timeline";
import { getLogger } from "@logtape/logtape";
import { acceptsLanguages } from "@std/http/negotiation";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import {
  TimelineNav,
  type TimelineNavItem,
} from "../components/TimelineNav.tsx";
import { db } from "../db.ts";
import { Composer } from "../islands/Composer.tsx";
import { RecommendedActors } from "../islands/RecommendedActors.tsx";
import { kv } from "../kv.ts";
import { define } from "../utils.ts";

const logger = getLogger(["hackerspub", "routes", "index"]);

const DEFAULT_WINDOW = 50;

export const handler = define.handlers({
  async GET(ctx) {
    const filterString = ctx.url.searchParams.get("filter");
    let filter: TimelineNavItem;
    if (
      filterString === "local" || filterString === "withoutShares" ||
      filterString === "articlesOnly" ||
      ctx.state.account != null &&
        (filterString === "feed" || filterString === "fediverse" ||
          filterString === "recommendations")
    ) {
      filter = filterString;
    } else {
      filter = ctx.state.account == null ? "fediverse" : "feed";
    }
    const untilString = ctx.url.searchParams.get("until");
    const until = untilString == null || !untilString.match(/^\d+(\.\d+)?$/)
      ? undefined
      : new Date(parseInt(untilString));
    const windowString = ctx.url.searchParams.get("window");
    const window = windowString == null || !windowString.match(/^\d+$/)
      ? DEFAULT_WINDOW
      : parseInt(windowString);
    let timeline: TimelineEntry[];
    const languages = new Set<string>(
      acceptsLanguages(ctx.req)
        .filter((lang) => lang !== "*")
        .map((lang) => lang.replace(/-.*$/, "")),
    );
    logger.debug("Accepted languages: {languages}", { languages });
    if (ctx.state.account == null) {
      timeline = await getPublicTimeline(db, {
        languages,
        local: filter === "local",
        withoutShares: filter === "withoutShares",
        postType: filter === "articlesOnly" ? "Article" : undefined,
        until,
        window: window + 1,
      });
    } else {
      timeline = filter === "recommendations"
        ? []
        : filter === "fediverse" || filter === "local"
        ? await getPublicTimeline(db, {
          currentAccount: ctx.state.account,
          languages: new Set(ctx.state.locales),
          local: filter === "local",
          until,
          window: window + 1,
        })
        : await getPersonalTimeline(db, {
          currentAccount: ctx.state.account,
          withoutShares: filter === "withoutShares",
          postType: filter === "articlesOnly" ? "Article" : undefined,
          until,
          window: window + 1,
        });
    }
    let next: Date | undefined = undefined;
    if (timeline.length > window) {
      next = timeline[window].added;
      timeline = timeline.slice(0, window);
    }
    const recommendedActors = next == null || filter === "recommendations"
      ? await recommendActors(db, {
        mainLocale: ctx.state.locales.length > 0
          ? ctx.state.locales[0]
          : ctx.state.language,
        locales: ctx.state.locales,
        account: ctx.state.account,
        limit: 50,
      })
      : [];
    logger.debug("Recommended actors: {recommendedActors}", {
      recommendedActors,
    });
    const recommendedActorMentions = await extractMentionsFromHtml(
      ctx.state.fedCtx,
      recommendedActors.map((actor) => actor.bioHtml).join("\n"),
      ctx.state.account == null ? { kv } : {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(
          ctx.state.account,
        ),
        kv,
      },
    );
    ctx.state.metas.push(
      { name: "description", content: ctx.state.t("home.intro.content") },
      { property: "og:title", content: "Hackers' Pub" },
      {
        property: "og:description",
        content: ctx.state.t("home.intro.content"),
      },
      {
        property: "og:url",
        content: new URL("/", ctx.state.canonicalOrigin).href,
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: new URL("/og.png", ctx.state.canonicalOrigin).href,
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
      { name: "twitter:card", content: "summary_large_image" },
    );
    ctx.state.links.push(
      { rel: "canonical", href: new URL("/", ctx.state.canonicalOrigin).href },
    );
    return page<HomeProps>({
      intro: filter !== "recommendations" &&
        (ctx.state.account == null || timeline.length < 1),
      composer: ctx.state.account != null,
      filter,
      timeline,
      next,
      window,
      recommendedActors,
      recommendedActorMentions,
    });
  },
});

interface HomeProps {
  intro: boolean;
  composer: boolean;
  filter: TimelineNavItem;
  timeline: ({
    post: Post & {
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      link: PostLink & { creator?: Actor | null } | null;
      sharedPost:
        | Post & {
          actor: Actor & {
            instance: Instance;

            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          replyTarget:
            | Post & {
              actor: Actor & {
                instance: Instance;
                followers: Following[];
                blockees: Blocking[];
                blockers: Blocking[];
              };
              link: PostLink & { creator?: Actor | null } | null;
              mentions: (Mention & { actor: Actor })[];
              media: PostMedium[];
            }
            | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
          shares: Post[];
          reactions: Reaction[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    };
    lastSharer: Actor | null;
    sharersCount: number;
    added: Date;
  })[];
  next?: Date;
  window: number;
  recommendedActors: (Actor & { account?: Account | null })[];
  recommendedActorMentions: { actor: Actor }[];
}

export default define.page<typeof handler, HomeProps>(
  function Home({ state, data }) {
    const nextHref = data.next == null
      ? undefined
      : data.window === DEFAULT_WINDOW
      ? `?filter=${data.filter}&until=${+data.next}`
      : `?filter=${data.filter}&until=${+data.next}&window=${data.window}`;
    return (
      <>
        {data.composer && (
          <Composer
            language={state.language}
            postUrl={`/@${state.account!.username}`}
            defaultVisibility={state.account!.noteVisibility}
            onPost="reload"
          />
        )}
        {data.intro &&
          (
            <article>
              <PageTitle>
                <Msg $key="home.intro.title" />
              </PageTitle>
              <div class="prose prose-h2:text-xl dark:prose-invert">
                <p>
                  <Msg $key="home.intro.content" />
                </p>
              </div>
            </article>
          )}
        <TimelineNav active={data.filter} signedIn={state.account != null} />
        {data.filter !== "recommendations" && (
          <>
            {data.timeline.map((item) => (
              <PostExcerpt
                post={item.post}
                lastSharer={item.lastSharer}
                sharersCount={item.sharersCount}
                signedAccount={state.account}
              />
            ))}
            <PostPagination nextHref={nextHref} />
          </>
        )}
        {data.recommendedActors.length > 0 && (
          <RecommendedActors
            language={state.language}
            actors={data.recommendedActors}
            actorMentions={data.recommendedActorMentions}
            window={6}
            title={data.filter !== "recommendations"}
            class={data.filter === "recommendations" ? "mt-4" : ""}
            signedAccount={state.account}
          />
        )}
      </>
    );
  },
);

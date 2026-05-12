import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Meta } from "@solidjs/meta";
import {
  revalidate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { HttpHeader } from "@solidjs/start";
import { graphql } from "relay-runtime";
import {
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import {
  createFragment,
  createPaginationFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorHoverCard } from "~/components/ActorHoverCard.tsx";
import { ArticleCard } from "~/components/ArticleCard.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NoteCard } from "~/components/NoteCard.tsx";
import { NoteComposer } from "~/components/NoteComposer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { PostAvatar } from "~/components/PostAvatar.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import { QuestionCard } from "~/components/QuestionCard.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  NoteId_articleBody$key,
} from "./__generated__/NoteId_articleBody.graphql.ts";
import type {
  NoteId_contextPost$data,
  NoteId_contextPost$key,
} from "./__generated__/NoteId_contextPost.graphql.ts";
import type {
  NoteIdPageQuery,
  NoteIdPageQuery$data,
} from "./__generated__/NoteIdPageQuery.graphql.ts";
import type { NoteId_head$key } from "./__generated__/NoteId_head.graphql.ts";
import type { NoteId_noteBody$key } from "./__generated__/NoteId_noteBody.graphql.ts";
import type { NoteId_questionBody$key } from "./__generated__/NoteId_questionBody.graphql.ts";
import type { NoteIdThreadQuery } from "./__generated__/NoteIdThreadQuery.graphql.ts";
import type { NoteIdThread_post$key } from "./__generated__/NoteIdThread_post.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

type NoteIdPagePost = NonNullable<
  NonNullable<
    NoteIdPageQuery$data["actorByHandle"]
  >["postByUuid"]
>;
type NoteIdPageNote = Extract<NoteIdPagePost, { readonly __typename: "Note" }>;
type NoteIdPageQuestion = Extract<
  NoteIdPagePost,
  { readonly __typename: "Question" }
>;
type NoteIdPageArticle = Extract<
  NoteIdPagePost,
  { readonly __typename: "Article" }
>;

const NOTE_PAGE_QUERY_KEY = "loadNotePageQuery";
const NOTE_THREAD_QUERY_KEY = "loadNoteThreadQuery";

function revalidateNotePageQueries() {
  return revalidate([NOTE_PAGE_QUERY_KEY, NOTE_THREAD_QUERY_KEY]);
}

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const username = decodeURIComponent(args.params.handle!);
    const noteId = args.params.noteId!;
    if (!validateUuid(noteId)) return;
    const { i18n } = useLingui();

    void loadNotePageQuery(username.replace(/^@/, ""), noteId, i18n.locale);
    void loadNoteThreadQuery(username.replace(/^@/, ""), noteId);
  },
} satisfies RouteDefinition;

const NoteIdPageQuery = graphql`
  query NoteIdPageQuery($handle: String!, $noteId: UUID!, $locale: Locale) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        ...NoteId_head
        ... on Note {
          ...NoteId_noteBody
        }
        ... on Question {
          ...NoteId_questionBody
        }
        ... on Article {
          ...NoteId_articleBody @arguments(locale: $locale)
        }
      }
    }
    viewer {
      id
    }
  }
`;

const loadNotePageQuery = routePreloadedQuery(
  (username: string, noteId: Uuid, locale: string) =>
    loadQuery<NoteIdPageQuery>(
      useRelayEnvironment()(),
      NoteIdPageQuery,
      { handle: username, noteId, locale },
    ),
  NOTE_PAGE_QUERY_KEY,
);

const NoteIdThreadQuery = graphql`
  query NoteIdThreadQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        ...NoteIdThread_post
      }
    }
  }
`;

const loadNoteThreadQuery = routePreloadedQuery(
  (username: string, noteId: Uuid) =>
    loadQuery<NoteIdThreadQuery>(
      useRelayEnvironment()(),
      NoteIdThreadQuery,
      { handle: username, noteId },
      { fetchPolicy: "store-and-network" },
    ),
  NOTE_THREAD_QUERY_KEY,
);

export default function NotePage() {
  const params = useParams();
  return (
    <Show
      when={validateUuid(params.noteId!)}
      fallback={<NotFoundPage embedded />}
    >
      <NotePageLoaded
        noteId={params.noteId! as Uuid}
        username={decodeURIComponent(params.handle!).replace(/^@/, "")}
      />
    </Show>
  );
}

interface NotePageLoadedProps {
  noteId: Uuid;
  username: string;
}

function NotePageLoaded(props: NotePageLoadedProps) {
  const { onNoteCreated } = useNoteCompose();
  const { i18n } = useLingui();

  onMount(() => {
    onCleanup(onNoteCreated(() => void revalidateNotePageQueries()));
  });

  const noteData = createPreloadedQuery<NoteIdPageQuery>(
    NoteIdPageQuery,
    () => loadNotePageQuery(props.username, props.noteId, i18n.locale),
  );

  const post = () => noteData()?.actorByHandle?.postByUuid;
  const note = (): NoteIdPageNote | null => {
    const currentPost = post();
    return currentPost?.__typename === "Note"
      ? currentPost as NoteIdPageNote
      : null;
  };
  const question = (): NoteIdPageQuestion | null => {
    const currentPost = post();
    return currentPost?.__typename === "Question"
      ? currentPost as NoteIdPageQuestion
      : null;
  };
  const article = (): NoteIdPageArticle | null => {
    const currentPost = post();
    return currentPost?.__typename === "Article"
      ? currentPost as NoteIdPageArticle
      : null;
  };
  const viewer = () => noteData()?.viewer ?? undefined;

  return (
    <Show when={noteData() != null}>
      <Switch fallback={<NotFoundPage embedded />}>
        <Match keyed when={note()}>
          {(note) => (
            <>
              <PostMetaHead $post={note} />
              <NoteInternal
                $note={note}
                $viewer={viewer()}
                noteId={props.noteId}
                username={props.username}
              />
            </>
          )}
        </Match>
        <Match keyed when={question()}>
          {(question) => (
            <>
              <PostMetaHead $post={question} />
              <QuestionInternal
                $question={question}
                $viewer={viewer()}
                noteId={props.noteId}
                username={props.username}
              />
            </>
          )}
        </Match>
        <Match keyed when={article()}>
          {(article) => (
            <>
              <PostMetaHead $post={article} />
              <ArticleInternal
                $article={article}
                $viewer={viewer()}
                noteId={props.noteId}
                username={props.username}
              />
            </>
          )}
        </Match>
      </Switch>
    </Show>
  );
}

interface PostMetaHeadProps {
  $post: NoteId_head$key;
}

function PostMetaHead(props: PostMetaHeadProps) {
  const { t } = useLingui();
  const post = createFragment(
    graphql`
      fragment NoteId_head on Post {
        content
        excerpt
        published
        updated
        actor {
          handle
          name
          username
        }
        language
        iri
        hashtags {
          name
        }
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(post) => (
        <>
          <Title>{t`${post.actor.name}: ${post.excerpt}`}</Title>
          <Meta property="og:title" content={post.excerpt} />
          <Meta property="og:description" content={post.excerpt} />
          <Meta property="og:type" content="article" />
          <Meta
            property="article:published_time"
            content={post.published}
          />
          <Meta
            property="article:modified_time"
            content={post.updated}
          />
          <Show keyed when={post.actor.name}>
            {(name) => (
              <Meta
                property="article:author"
                content={name}
              />
            )}
          </Show>
          <Meta
            property="article:author.username"
            content={post.actor.username}
          />
          <Meta
            name="fediverse:creator"
            content={post.actor.handle.replace(/^@/, "")}
          />
          <For each={post.hashtags}>
            {(hashtag) => (
              <Meta
                property="article:tag"
                content={hashtag.name}
              />
            )}
          </For>
          <Show keyed when={post.language}>
            {(language) => (
              <Meta
                property="og:locale"
                content={language}
              />
            )}
          </Show>

          <HttpHeader
            name="Link"
            value={`<${post.iri}>; rel="alternate"; type="application/activity+json"`}
          />
        </>
      )}
    </Show>
  );
}

interface NoteInternalProps {
  $note: NoteId_noteBody$key;
  $viewer?: { readonly id: string } | null;
  noteId: Uuid;
  username: string;
}

function NoteInternal(props: NoteInternalProps) {
  const { t } = useLingui();
  const navigate = useNavigate();

  const note = createFragment(
    graphql`
      fragment NoteId_noteBody on Note {
        id
        visibility
        iri
        url
        ...NoteCard_note
      }
    `,
    () => props.$note,
  );
  return (
    <Show keyed when={note()}>
      {(note) => {
        const defaultVisibility = (): PostVisibility => {
          const v = note.visibility;
          if (
            v === "PUBLIC" || v === "UNLISTED" ||
            v === "FOLLOWERS" || v === "DIRECT"
          ) return v;
          return "PUBLIC";
        };
        return (
          <NarrowContainer>
            <div class="my-4">
              <PermalinkThread noteId={props.noteId} username={props.username}>
                <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl text-xl">
                  <NoteCard $note={note} onDeleted={() => navigate(-1)} />
                  <Show when={props.$viewer != null}>
                    <div class="px-4 pb-4 border-t pt-4 text-base">
                      <NoteComposer
                        replyTargetId={note.id}
                        defaultVisibility={defaultVisibility()}
                        placeholder={t`Write a reply…`}
                        onSuccess={() => void revalidateNotePageQueries()}
                        showReplyTarget={false}
                      />
                    </div>
                  </Show>
                  <Show when={props.$viewer == null}>
                    <p class="p-4 text-sm text-muted-foreground">
                      <Trans
                        message={t`If you have a fediverse account, you can reply to this note from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                        values={{
                          ACTIVITYPUB_URI: () => (
                            <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                              {note.iri}
                            </span>
                          ),
                        }}
                      />
                    </p>
                  </Show>
                </div>
              </PermalinkThread>
            </div>
          </NarrowContainer>
        );
      }}
    </Show>
  );
}

interface QuestionInternalProps {
  $question: NoteId_questionBody$key;
  $viewer?: { readonly id: string } | null;
  noteId: Uuid;
  username: string;
}

function QuestionInternal(props: QuestionInternalProps) {
  const { t } = useLingui();
  const navigate = useNavigate();

  const question = createFragment(
    graphql`
      fragment NoteId_questionBody on Question {
        id
        visibility
        iri
        url
        ...QuestionCard_question
      }
    `,
    () => props.$question,
  );
  return (
    <Show keyed when={question()}>
      {(question) => {
        const defaultVisibility = (): PostVisibility => {
          const v = question.visibility;
          if (
            v === "PUBLIC" || v === "UNLISTED" ||
            v === "FOLLOWERS" || v === "DIRECT"
          ) return v;
          return "PUBLIC";
        };
        return (
          <NarrowContainer>
            <div class="my-4">
              <PermalinkThread noteId={props.noteId} username={props.username}>
                <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl text-xl">
                  <QuestionCard
                    $question={question}
                    onDeleted={() => navigate(-1)}
                  />
                  <Show when={props.$viewer != null}>
                    <div class="px-4 pb-4 border-t pt-4 text-base">
                      <NoteComposer
                        replyTargetId={question.id}
                        defaultVisibility={defaultVisibility()}
                        placeholder={t`Write a reply…`}
                        onSuccess={() => void revalidateNotePageQueries()}
                        showReplyTarget={false}
                      />
                    </div>
                  </Show>
                  <Show when={props.$viewer == null}>
                    <p class="p-4 text-sm text-muted-foreground">
                      <Trans
                        message={t`If you have a fediverse account, you can reply to this post from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                        values={{
                          ACTIVITYPUB_URI: () => (
                            <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                              {question.iri}
                            </span>
                          ),
                        }}
                      />
                    </p>
                  </Show>
                </div>
              </PermalinkThread>
            </div>
          </NarrowContainer>
        );
      }}
    </Show>
  );
}

interface ArticleInternalProps {
  $article: NoteId_articleBody$key;
  $viewer?: { readonly id: string } | null;
  noteId: Uuid;
  username: string;
}

function ArticleInternal(props: ArticleInternalProps) {
  const { t } = useLingui();

  const article = createFragment(
    graphql`
      fragment NoteId_articleBody on Article
        @argumentDefinitions(locale: { type: "Locale" })
      {
        id
        visibility
        iri
        url
        ...ArticleCard_article @arguments(locale: $locale)
      }
    `,
    () => props.$article,
  );
  return (
    <Show keyed when={article()}>
      {(article) => {
        const defaultVisibility = (): PostVisibility => {
          const v = article.visibility;
          if (
            v === "PUBLIC" || v === "UNLISTED" ||
            v === "FOLLOWERS" || v === "DIRECT"
          ) return v;
          return "PUBLIC";
        };
        return (
          <NarrowContainer>
            <div class="my-4">
              <PermalinkThread noteId={props.noteId} username={props.username}>
                <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl text-xl">
                  <ArticleCard $article={article} />
                  <Show when={props.$viewer != null}>
                    <div class="px-4 pb-4 border-t pt-4 text-base">
                      <NoteComposer
                        replyTargetId={article.id}
                        defaultVisibility={defaultVisibility()}
                        placeholder={t`Write a reply…`}
                        onSuccess={() => void revalidateNotePageQueries()}
                        showReplyTarget={false}
                      />
                    </div>
                  </Show>
                  <Show when={props.$viewer == null}>
                    <p class="p-4 text-sm text-muted-foreground">
                      <Trans
                        message={t`If you have a fediverse account, you can reply to this article from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                        values={{
                          ACTIVITYPUB_URI: () => (
                            <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                              {article.iri}
                            </span>
                          ),
                        }}
                      />
                    </p>
                  </Show>
                </div>
              </PermalinkThread>
            </div>
          </NarrowContainer>
        );
      }}
    </Show>
  );
}

interface PermalinkThreadProps {
  children: JSX.Element;
  noteId: Uuid;
  username: string;
}

function PermalinkThread(props: PermalinkThreadProps) {
  return (
    // Guard against transiently-invalid params during route transitions:
    // useParams() can briefly reflect a different route before this component
    // unmounts, causing createPreloadedQuery to fire with undefined noteId.
    <Show when={validateUuid(props.noteId)} fallback={<>{props.children}</>}>
      <ErrorBoundary fallback={() => <>{props.children}</>}>
        <PermalinkThreadLoaded {...props} />
      </ErrorBoundary>
    </Show>
  );
}

function PermalinkThreadLoaded(props: PermalinkThreadProps) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const data = createPreloadedQuery<NoteIdThreadQuery>(
    NoteIdThreadQuery,
    () => loadNoteThreadQuery(props.username, props.noteId),
  );
  const thread = createPaginationFragment(
    graphql`
      fragment NoteIdThread_post on Post
        @refetchable(queryName: "NoteIdThreadPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        replyTarget {
          ...NoteId_contextPost
        }
        replies(after: $cursor, first: $count)
          @connection(key: "NoteIdThread_replies")
        {
          edges {
            node {
              ...NoteId_contextPost
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => data()?.actorByHandle?.postByUuid as NoteIdThread_post$key,
  );
  const replyTarget = () => thread()?.replyTarget;
  const replies = () => thread()?.replies.edges ?? [];

  function onLoadMore() {
    setLoadingState("loading");
    thread.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <Show when={thread() != null} fallback={props.children}>
      <div class="contents">
        <Show keyed when={replyTarget()}>
          {(parent) => (
            <div class="border-x border-t rounded-t-xl overflow-hidden">
              <ContextPostCard $post={parent} />
            </div>
          )}
        </Show>
        {props.children}
        <Show when={replies().length > 0}>
          <div class="border-x border-b rounded-b-xl overflow-hidden">
            <For each={replies()}>
              {(edge) => (
                <Show keyed when={edge.node}>
                  {(reply) => <ContextPostCard $post={reply} />}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Show when={thread.hasNext}>
          <button
            type="button"
            on:click={loadingState() === "loading" ? undefined : onLoadMore}
            disabled={thread.pending || loadingState() === "loading"}
            class="block w-full cursor-pointer border-x border-b rounded-b-xl px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Switch>
              <Match when={thread.pending || loadingState() === "loading"}>
                {t`Loading more replies…`}
              </Match>
              <Match when={loadingState() === "errored"}>
                {t`Failed to load more replies; click to retry`}
              </Match>
              <Match when={loadingState() === "loaded"}>
                {t`Load more replies`}
              </Match>
            </Switch>
          </button>
        </Show>
      </div>
    </Show>
  );
}

interface ContextPostCardProps {
  $post: NoteId_contextPost$key;
}

function ContextPostCard(props: ContextPostCardProps) {
  const post = createFragment(
    graphql`
      fragment NoteId_contextPost on Post {
        __typename
        uuid
        name
        excerpt
        published
        url
        iri
        ... on Article {
          publishedYear
          slug
        }
        ... on Note {
          sourceId
        }
        actor {
          name
          handle
          username
          local
          url
          iri
          ...PostAvatar_actor
        }
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(post) => {
        const href = () => post.url ?? post.iri;
        const internalHref = () => getContextPostInternalHref(post);
        return (
          <article class="border-b px-4 py-3 transition-colors hover:bg-muted/30 last:border-none">
            <div class="flex gap-3 sm:gap-4">
              <PostAvatar $actor={post.actor} />
              <div class="min-w-0 grow">
                <div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                  <ActorHoverCard
                    handle={post.actor.handle}
                    class="min-w-0 grow flex flex-wrap items-baseline gap-x-1"
                  >
                    <Show when={(post.actor.name ?? "").trim() !== ""}>
                      <InternalLink
                        href={post.actor.url ?? post.actor.iri}
                        internalHref={post.actor.local
                          ? `/@${post.actor.username}`
                          : `/${post.actor.handle}`}
                        innerHTML={post.actor.name ?? ""}
                        class="font-semibold"
                      />
                    </Show>
                    <span
                      class="min-w-0 truncate select-all text-muted-foreground"
                      title={post.actor.handle}
                    >
                      {post.actor.handle}
                    </span>
                  </ActorHoverCard>
                  <span class="flex items-center gap-1.5 text-sm text-muted-foreground/70">
                    <ContextPostLink
                      href={href()}
                      internalHref={internalHref()}
                    >
                      <Timestamp value={post.published} capitalizeFirstLetter />
                    </ContextPostLink>
                  </span>
                </div>
                <ContextPostLink
                  href={href()}
                  internalHref={internalHref()}
                  class="mt-1 block text-sm text-foreground"
                >
                  <Show
                    when={post.name != null && post.name.trim() !== ""}
                    fallback={post.excerpt}
                  >
                    <span class="font-medium">{post.name}</span>
                  </Show>
                </ContextPostLink>
              </div>
            </div>
          </article>
        );
      }}
    </Show>
  );
}

function getContextPostInternalHref(
  post: NoteId_contextPost$data,
): string | null {
  const actorSegment = post.actor.local
    ? `@${post.actor.username}`
    : encodeHandleSegment(post.actor.handle);
  switch (post.__typename) {
    case "Article":
      if (
        post.actor.local &&
        post.publishedYear != null &&
        post.slug != null
      ) {
        return `/@${post.actor.username}/${post.publishedYear}/${post.slug}`;
      }
      // Articles without a pretty permalink (remote, or local rows
      // that haven't materialised `publishedYear`/`slug`) route through
      // the UUID-based `[noteId]` permalink, which now accepts
      // articles.
      return `/${actorSegment}/${post.uuid}`;
    case "Note": {
      // Source-backed local notes: canonical permalink uses `sourceId`
      // (= `noteSourceTable.id`), matching the path embedded in
      // `Post.url`. For everything else — remote notes and local share
      // wrappers (boosts), neither of which carries a source row — fall
      // back to `uuid` (= `postTable.id`), the internal route token.
      const id = post.sourceId ?? post.uuid;
      return `/${actorSegment}/${id}`;
    }
    case "Question":
      // Question originals only come from remote instances, and any
      // local Question rows exist solely as share wrappers (boosts).
      // Neither case carries a local source row, so the row PK is the
      // right token for our internal route.
      return `/${actorSegment}/${post.uuid}`;
    default:
      return null;
  }
}

interface ContextPostLinkProps
  extends Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target"> {
  internalHref: string | null;
}

function ContextPostLink(props: ContextPostLinkProps) {
  const [local, anchorProps] = splitProps(props, [
    "children",
    "internalHref",
  ]);
  return (
    <Show
      keyed
      when={local.internalHref}
      fallback={<a {...anchorProps}>{local.children}</a>}
    >
      {(internalHref) => (
        <InternalLink {...anchorProps} internalHref={internalHref}>
          {local.children}
        </InternalLink>
      )}
    </Show>
  );
}

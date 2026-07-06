import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Link, Meta } from "@solidjs/meta";
import {
  revalidate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpHeader } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { createFragment, loadQuery, useRelayEnvironment } from "solid-relay";
import { ArticleCard } from "~/components/ArticleCard.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NoteCard } from "~/components/NoteCard.tsx";
import { NoteComposer } from "~/components/NoteComposer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import {
  PERMALINK_THREAD_QUERY_KEY,
  PermalinkThread,
} from "~/components/PermalinkThread.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import { QuestionCard } from "~/components/QuestionCard.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  NoteId_articleBody$key,
} from "./__generated__/NoteId_articleBody.graphql.ts";
import type {
  NoteIdPageQuery,
  NoteIdPageQuery$data,
} from "./__generated__/NoteIdPageQuery.graphql.ts";
import type { NoteId_head$key } from "./__generated__/NoteId_head.graphql.ts";
import type { NoteId_noteBody$key } from "./__generated__/NoteId_noteBody.graphql.ts";
import type { NoteId_questionBody$key } from "./__generated__/NoteId_questionBody.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

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
const NOTE_TITLE_EXCERPT_GRAPHEME_LIMIT = 80;

function revalidateNotePageQueries() {
  return revalidate([NOTE_PAGE_QUERY_KEY, PERMALINK_THREAD_QUERY_KEY]);
}

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const NoteIdPageQuery = graphql`
  query NoteIdPageQuery(
    $handle: String!
    $noteId: UUID!
    $locale: Locale
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId, actingAccountId: $actingAccountId) {
        __typename
        ...NoteId_head
        ... on Note {
          ...NoteId_noteBody @arguments(actingAccountId: $actingAccountId)
        }
        ... on Question {
          ...NoteId_questionBody @arguments(
            actingAccountId: $actingAccountId
          )
        }
        ... on Article {
          ...NoteId_articleBody @arguments(
            locale: $locale
            actingAccountId: $actingAccountId
          )
        }
      }
    }
    viewer {
      id
    }
  }
`;

const loadNotePageQuery = routePreloadedQuery(
  (
    username: string,
    noteId: Uuid,
    locale: string,
    actingAccountId: string | null,
  ) =>
    loadQuery<NoteIdPageQuery>(
      useRelayEnvironment()(),
      NoteIdPageQuery,
      { handle: username, noteId, locale, actingAccountId },
    ),
  NOTE_PAGE_QUERY_KEY,
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
        username={decodeRouteParam(params.handle!).replace(/^@/, "")}
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
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  onMount(() => {
    onCleanup(onNoteCreated(() => void revalidateNotePageQueries()));
  });

  const noteData = createStablePreloadedQuery<NoteIdPageQuery>(
    NoteIdPageQuery,
    () =>
      loadNotePageQuery(
        props.username,
        props.noteId,
        i18n.locale,
        actingAccountId() ?? null,
      ),
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
        __typename
        content
        excerpt
        published
        updated
        actor {
          handle
          rawName
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
      {(post) => {
        const titleExcerpt = () => {
          if (post.__typename !== "Note") return post.excerpt;
          const excerpt = post.excerpt.replace(/\s+/g, " ").trim();
          const graphemes = Array.from(
            new Intl.Segmenter(undefined, { granularity: "grapheme" })
              .segment(excerpt),
            ({ segment }) => segment,
          );
          if (graphemes.length <= NOTE_TITLE_EXCERPT_GRAPHEME_LIMIT) {
            return excerpt;
          }
          return `${
            graphemes
              .slice(0, NOTE_TITLE_EXCERPT_GRAPHEME_LIMIT - 1)
              .join("")
              .trimEnd()
          }…`;
        };
        return (
          <>
            <Title>
              {t`${
                post.actor.rawName ?? post.actor.username
              }: ${titleExcerpt()}`}
            </Title>
            <Meta property="og:title" content={titleExcerpt()} />
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
            <Show keyed when={post.actor.rawName}>
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

            <Link
              rel="alternate"
              type="application/activity+json"
              href={post.iri}
            />
            <HttpHeader
              name="Link"
              value={`<${post.iri}>; rel="alternate"; type="application/activity+json"`}
            />
          </>
        );
      }}
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
      fragment NoteId_noteBody on Note
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        id
        visibility
        iri
        url
        ...NoteCard_note @arguments(actingAccountId: $actingAccountId)
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
      fragment NoteId_questionBody on Question
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        id
        visibility
        iri
        url
        ...QuestionCard_question @arguments(actingAccountId: $actingAccountId)
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
        @argumentDefinitions(
          locale: { type: "Locale" }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        id
        visibility
        iri
        url
        ...ArticleCard_article @arguments(
          locale: $locale
          actingAccountId: $actingAccountId
        )
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

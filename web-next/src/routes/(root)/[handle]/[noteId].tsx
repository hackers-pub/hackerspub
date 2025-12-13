import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { HttpHeader, HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
  createFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NoteCard } from "../../../components/NoteCard.tsx";
import type { NoteIdPageQuery } from "./__generated__/NoteIdPageQuery.graphql.ts";
import type { NoteId_body$key } from "./__generated__/NoteId_body.graphql.ts";
import type { NoteId_head$key } from "./__generated__/NoteId_head.graphql.ts";
import type { NoteId_viewer$key } from "./__generated__/NoteId_viewer.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const username = args.params.handle!;
    const noteId = args.params.noteId!;
    if (!validateUuid(noteId)) {
      throw new Error("Invalid Request"); // FIXME
    }

    void loadPageQuery(username.substring(1), noteId);
  },
} satisfies RouteDefinition;

const NoteIdPageQuery = graphql`
  query NoteIdPageQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      noteByUuid(uuid: $noteId) {
        ...NoteId_head
        ...NoteId_body
      }
    }
    viewer {
      ...NoteId_viewer
    }
  }
`;

const loadPageQuery = query(
  (username: string, noteId: Uuid) =>
    loadQuery<NoteIdPageQuery>(
      useRelayEnvironment()(),
      NoteIdPageQuery,
      { handle: username, noteId },
    ),
  "loadNotePageQuery",
);

export default function NotePage() {
  const params = useParams();
  const noteId = params.noteId!;
  const username = params.handle!.substring(1);

  if (!validateUuid(noteId)) {
    return <HttpStatusCode code={404} />;
  }

  const data = createPreloadedQuery<NoteIdPageQuery>(
    NoteIdPageQuery,
    () => loadPageQuery(username, noteId),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().actorByHandle}
            fallback={<HttpStatusCode code={404} />}
          >
            {(actor) => (
              <Show
                when={actor().noteByUuid}
                fallback={<HttpStatusCode code={404} />}
              >
                {(note) => (
                  <>
                    <NoteMetaHead $note={note()} />
                    <NoteInternal
                      $note={note()}
                      $viewer={data().viewer ?? undefined}
                    />
                  </>
                )}
              </Show>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

interface NoteMetaHeadProps {
  $note: NoteId_head$key;
}

function NoteMetaHead(props: NoteMetaHeadProps) {
  const { t } = useLingui();
  const note = createFragment(
    graphql`
      fragment NoteId_head on Note {
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
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <>
          <Title>{t`${note().actor.name}: ${note().excerpt}`}</Title>
          <Meta property="og:title" content={note().excerpt} />
          <Meta property="og:description" content={note().excerpt} />
          <Meta property="og:type" content="article" />
          <Meta
            property="article:published_time"
            content={note().published}
          />
          <Meta
            property="article:modified_time"
            content={note().updated}
          />
          <Show when={note().actor.name}>
            {(name) => (
              <Meta
                property="article:author"
                content={name()}
              />
            )}
          </Show>
          <Meta
            property="article:author.username"
            content={note().actor.username}
          />
          <Meta
            name="fediverse:creator"
            content={note().actor.handle.replace(/^@/, "")}
          />
          <For each={note().hashtags}>
            {(hashtag) => (
              <Meta
                property="article:tag"
                content={hashtag.name}
              />
            )}
          </For>
          <Show when={note().language}>
            {(language) => (
              <Meta
                property="og:locale"
                content={language()}
              />
            )}
          </Show>

          <HttpHeader
            name="Link"
            value={`<${note().iri}>; rel="alternate"; type="application/activity+json"`}
          />
        </>
      )}
    </Show>
  );
}

interface NoteInternalProps {
  $note: NoteId_body$key;
  $viewer?: NoteId_viewer$key;
}

function NoteInternal(props: NoteInternalProps) {
  const { t } = useLingui();

  const note = createFragment(
    graphql`
      fragment NoteId_body on Note {
        iri
        url
        ...NoteCard_note
        replyTarget {
          ...NoteCard_note
        }
        replies {
          edges {
            node {
              ...NoteCard_note
            }
          }
        }
      }
    `,
    () => props.$note,
  );
  const viewer = createFragment(
    graphql`
      fragment NoteId_viewer on Account {
        id
      }
    `,
    () => props.$viewer,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <>
          <div class="my-4">
            <Show when={note().replyTarget}>
              {(parent) => (
                <div class="border-x border-t rounded-t-xl max-w-prose mx-auto">
                  <NoteCard $note={parent()} />
                </div>
              )}
            </Show>
            <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto text-xl">
              <NoteCard $note={note()} zoom />
              <Show when={viewer() == null}>
                <p class="p-4 text-sm text-muted-foreground">
                  <Trans
                    message={t`If you have a fediverse account, you can reply to this note from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                    values={{
                      ACTIVITYPUB_URI: () => (
                        <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                          {note().iri}
                        </span>
                      ),
                    }}
                  />
                </p>
              </Show>
            </div>
            <Show when={note().replies?.edges.length}>
              <div class="border-x border-b rounded-b-xl max-w-prose mx-auto">
                <For each={note().replies?.edges}>
                  {(edge) => <NoteCard $note={edge.node} />}
                </For>
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}

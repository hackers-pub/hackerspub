import { validateUuid } from "@hackerspub/models/uuid";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  revalidate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createEffect, createSignal, Show } from "solid-js";
import {
  createFragment,
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import { QuotePolicySelect } from "~/components/QuotePolicySelect.tsx";
import { Button } from "~/components/ui/button.tsx";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type { editNotePageQuery } from "./__generated__/editNotePageQuery.graphql.ts";
import type { editNote_note$key } from "./__generated__/editNote_note.graphql.ts";
import type { editNote_updateNote_Mutation } from "./__generated__/editNote_updateNote_Mutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const noteEditPageQueryDef = graphql`
  query editNotePageQuery($handle: String!, $noteId: UUID!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      postByUuid(uuid: $noteId) {
        __typename
        ... on Note {
          ...editNote_note
        }
      }
    }
  }
`;

const loadNoteEditPageQuery = routePreloadedQuery(
  (handle: string, noteId: Uuid) =>
    loadQuery<editNotePageQuery>(
      useRelayEnvironment()(),
      noteEditPageQueryDef,
      { handle, noteId },
      { fetchPolicy: "network-only" },
    ),
  "loadNoteEditPageQuery",
);

export default function NoteEditPage() {
  const params = useParams();
  return (
    <Show
      when={validateUuid(params.noteId!)}
      fallback={<NotFoundPage embedded />}
    >
      <NoteEditPageLoaded
        noteId={params.noteId! as Uuid}
        handle={params.handle!}
      />
    </Show>
  );
}

interface NoteEditPageLoadedProps {
  noteId: Uuid;
  handle: string;
}

function NoteEditPageLoaded(props: NoteEditPageLoadedProps) {
  const data = createPreloadedQuery<editNotePageQuery>(
    noteEditPageQueryDef,
    () => loadNoteEditPageQuery(props.handle, props.noteId),
  );

  const post = () => data()?.actorByHandle?.postByUuid;

  return (
    <Show when={data()}>
      <Show
        keyed
        when={post()?.__typename === "Note" ? post() : undefined}
        fallback={<NotFoundPage embedded />}
      >
        {(note) => <NoteEditForm $note={note as editNote_note$key} />}
      </Show>
    </Show>
  );
}

interface NoteEditFormProps {
  $note: editNote_note$key;
}

const updateNoteMutation = graphql`
  mutation editNote_updateNote_Mutation($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      __typename
      ... on UpdateNotePayload {
        note {
          id
          rawContent
          language
          quotePolicy
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

function NoteEditForm(props: NoteEditFormProps) {
  const { t } = useLingui();
  const navigate = useNavigate();

  const note = createFragment(
    graphql`
      fragment editNote_note on Note {
        id
        sourceId
        rawContent
        language
        visibility
        quotePolicy
        actor {
          isViewer
          username
        }
      }
    `,
    () => props.$note,
  );

  const [commitUpdate, isUpdating] = createMutation<
    editNote_updateNote_Mutation
  >(updateNoteMutation);

  const [markdown, setMarkdown] = createSignal(note()?.rawContent ?? "");
  const langCode = note()?.language;
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    langCode ? new Intl.Locale(langCode) : undefined,
  );
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy>(
    (note()?.quotePolicy as QuotePolicy | null | undefined) ?? "EVERYONE",
  );

  // Re-initialize form state once note data is available (handles SSR
  // hydration where signals may initialize before the Relay store is
  // populated on the client).
  let initialized = false;
  createEffect(() => {
    const n = note();
    if (!n || initialized) return;
    initialized = true;
    setMarkdown(n.rawContent ?? "");
    const lc = n.language;
    setLanguage(lc ? new Intl.Locale(lc) : undefined);
    setQuotePolicy((n.quotePolicy as QuotePolicy) ?? "EVERYONE");
  });

  const handleSave = (e: SubmitEvent) => {
    e.preventDefault();
    const n = note();
    if (!n) return;
    if (!markdown().trim()) {
      showToast({
        title: t`Error`,
        description: t`Content cannot be empty`,
        variant: "error",
      });
      return;
    }

    const isPublicOrUnlisted = n.visibility === "PUBLIC" ||
      n.visibility === "UNLISTED";
    commitUpdate({
      variables: {
        input: {
          noteId: n.id,
          content: markdown(),
          language: language()?.baseName,
          quotePolicy: isPublicOrUnlisted ? quotePolicy() : undefined,
        },
      },
      onCompleted(response) {
        if (response.updateNote.__typename === "UpdateNotePayload") {
          showToast({
            title: t`Success`,
            description: t`Note updated`,
            variant: "success",
          });
          revalidate("loadNotePageQuery");
          navigate(`/@${n.actor.username}/${n.sourceId}`);
        } else if (response.updateNote.__typename === "InvalidInputError") {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.updateNote.inputPath}`,
            variant: "error",
          });
        } else if (
          response.updateNote.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to edit a note`,
            variant: "error",
          });
        }
      },
      onError(error) {
        console.error("Failed to update note:", error);
        showToast({
          title: t`Error`,
          description: t`Failed to update the note. Please try again.`,
          variant: "error",
        });
      },
    });
  };

  return (
    <Show
      when={note()?.actor.isViewer && note()?.sourceId != null}
      fallback={<HttpStatusCode code={403} />}
    >
      <div class="mt-8 mb-4 px-4 max-w-3xl mx-auto">
        <h1 class="text-2xl font-bold mb-6">{t`Edit note`}</h1>

        <form onSubmit={handleSave} class="flex flex-col gap-6">
          {/* Content */}
          <div class="flex flex-col gap-1">
            <label class="flex items-center justify-between text-sm font-medium">
              <span>{t`Content`}</span>
              <a
                href="/markdown"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
              >
                <svg
                  fill="currentColor"
                  height="128"
                  viewBox="0 0 208 128"
                  width="208"
                  xmlns="http://www.w3.org/2000/svg"
                  class="size-4"
                  stroke="currentColor"
                >
                  <g>
                    <path
                      clip-rule="evenodd"
                      d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                      fill-rule="evenodd"
                    />
                    <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
                  </g>
                </svg>
                {t`Markdown supported`}
              </a>
            </label>
            <MarkdownEditor
              value={markdown()}
              onInput={setMarkdown}
              placeholder={t`Write your note here.`}
              showToolbar
              minHeight="200px"
            />
          </div>

          {/* Language */}
          <div>
            <label class="text-sm font-medium">{t`Language`}</label>
            <LanguageSelect
              value={language()}
              onChange={setLanguage}
              class="mt-2"
            />
          </div>

          {/* Quote Policy — only meaningful for public/unlisted notes */}
          <Show
            when={note()?.visibility === "PUBLIC" ||
              note()?.visibility === "UNLISTED"}
          >
            <div>
              <label class="text-sm font-medium">
                {t`Who can quote this note`}
              </label>
              <div class="mt-2">
                <QuotePolicySelect
                  value={quotePolicy()}
                  onChange={setQuotePolicy}
                />
              </div>
            </div>
          </Show>

          {/* Actions */}
          <div class="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const n = note();
                if (n) {
                  navigate(`/@${n.actor.username}/${n.sourceId}`);
                }
              }}
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={isUpdating()}>
              {isUpdating() ? t`Saving…` : t`Save changes`}
            </Button>
          </div>
        </form>
      </div>
    </Show>
  );
}

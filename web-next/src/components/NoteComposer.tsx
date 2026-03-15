import { detectLanguage } from "~/lib/langdet.ts";
import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { createMutation, useRelayEnvironment } from "solid-relay";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { MentionAutocomplete } from "~/components/MentionAutocomplete.tsx";
import {
  PostVisibility,
  PostVisibilitySelect,
} from "~/components/PostVisibilitySelect.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconX from "~icons/lucide/x";
import type { NoteComposerMutation } from "./__generated__/NoteComposerMutation.graphql.ts";
import type { NoteComposerQuotedPostQuery } from "./__generated__/NoteComposerQuotedPostQuery.graphql.ts";

const NoteComposerMutation = graphql`
  mutation NoteComposerMutation($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note {
          id
          content
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

const NoteComposerQuotedPostQuery = graphql`
  query NoteComposerQuotedPostQuery($id: ID!) {
    node(id: $id) {
      ... on Note {
        __typename
        content
        actor {
          name
          handle
          avatarUrl
        }
      }
      ... on Article {
        __typename
        name
        content
        actor {
          name
          handle
          avatarUrl
        }
      }
    }
  }
`;

interface QuotedPostPreview {
  typename: "Note" | "Article";
  contentHtml: string;
  name?: string;
  actorName?: string;
  actorHandle: string;
  actorAvatarUrl: string;
}

export interface NoteComposerProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  showCancelButton?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  class?: string;
  quotedPostId?: string | null;
  onQuoteRemoved?: () => void;
}

export function NoteComposer(props: NoteComposerProps) {
  const { t, i18n } = useLingui();
  const environment = useRelayEnvironment();
  const [content, setContent] = createSignal("");
  const [visibility, setVisibility] = createSignal<PostVisibility>("PUBLIC");
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    new Intl.Locale(i18n.locale),
  );
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
  const [quotedPost, setQuotedPost] = createSignal<
    QuotedPostPreview | null
  >(null);
  const [createNote, isCreating] = createMutation<NoteComposerMutation>(
    NoteComposerMutation,
  );
  let textareaRef: HTMLTextAreaElement | undefined;

  // Fetch quoted post preview when quotedPostId changes
  createEffect(() => {
    const id = props.quotedPostId;
    if (!id) {
      setQuotedPost(null);
      return;
    }
    const subscription = fetchQuery<NoteComposerQuotedPostQuery>(
      environment(),
      NoteComposerQuotedPostQuery,
      { id },
    ).subscribe({
      next(data) {
        const node = data.node;
        if (
          !node ||
          (node.__typename !== "Note" && node.__typename !== "Article")
        ) {
          setQuotedPost(null);
          return;
        }
        if (!node.actor) {
          setQuotedPost(null);
          return;
        }
        setQuotedPost({
          typename: node.__typename,
          contentHtml: node.content,
          name: "name" in node ? (node.name ?? undefined) : undefined,
          actorName: node.actor.name ?? undefined,
          actorHandle: node.actor.handle,
          actorAvatarUrl: node.actor.avatarUrl,
        });
      },
      error() {
        setQuotedPost(null);
      },
    });
    onCleanup(() => subscription.unsubscribe());
  });

  createEffect(() => {
    if (manualLanguageChange()) return;

    const text = content().trim();
    const detectedLang = detectLanguage({
      text,
      acceptLanguage: null,
    });

    if (detectedLang) {
      setLanguage(new Intl.Locale(detectedLang));
    }
  });

  const handleLanguageChange = (locale?: Intl.Locale) => {
    setLanguage(locale);
    setManualLanguageChange(true);
  };

  const resetForm = () => {
    setContent("");
    setVisibility("PUBLIC");
    setLanguage(new Intl.Locale(i18n.locale));
    setManualLanguageChange(false);
    setQuotedPost(null);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();

    const noteContent = content().trim();
    if (!noteContent) {
      showToast({
        title: t`Error`,
        description: t`Content cannot be empty`,
        variant: "error",
      });
      return;
    }

    createNote({
      variables: {
        input: {
          content: noteContent,
          language: language()?.baseName ?? i18n.locale,
          visibility: visibility(),
          quotedPostId: quotedPost() ? (props.quotedPostId ?? null) : null,
        },
      },
      onCompleted(response) {
        if (response.createNote.__typename === "CreateNotePayload") {
          showToast({
            title: t`Success`,
            description: t`Note created successfully`,
            variant: "success",
          });
          resetForm();
          props.onSuccess?.();
        } else if (response.createNote.__typename === "InvalidInputError") {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.createNote.inputPath}`,
            variant: "error",
          });
        } else if (
          response.createNote.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to create a note`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  return (
    <form onSubmit={handleSubmit} class={props.class}>
      <div class="grid gap-4">
        {/* Quoted post preview */}
        <Show when={quotedPost()}>
          {(qp) => (
            <div class="flex items-start gap-3 rounded-md border border-input bg-muted/50 p-3">
              <Avatar class="size-8 flex-shrink-0">
                <AvatarImage src={qp().actorAvatarUrl} />
              </Avatar>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1 text-sm">
                  <span class="font-medium truncate">{qp().actorName}</span>
                  <span class="text-muted-foreground truncate">
                    {qp().actorHandle}
                  </span>
                </div>
                <Show when={qp().typename === "Article" && qp().name}>
                  <div class="text-sm font-medium mt-1">{qp().name}</div>
                </Show>
                <Show when={qp().contentHtml}>
                  {(html) => (
                    <div
                      class="text-sm text-muted-foreground mt-1 line-clamp-3 prose prose-sm dark:prose-invert max-w-none"
                      innerHTML={html()}
                    />
                  )}
                </Show>
              </div>
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground flex-shrink-0"
                onClick={() => props.onQuoteRemoved?.()}
                title={t`Remove quote`}
                aria-label={t`Remove quote`}
              >
                <IconX class="size-4" />
              </button>
            </div>
          )}
        </Show>

        <TextField>
          <TextFieldLabel class="flex items-center justify-between">
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
          </TextFieldLabel>
          <TextFieldTextArea
            ref={(el) => (textareaRef = el)}
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
            placeholder={props.placeholder ?? t`What's on your mind?`}
            required
            autofocus={props.autoFocus}
            class="min-h-[150px]"
          />
          <MentionAutocomplete
            textareaRef={() => textareaRef}
            onComplete={() => {
              // Update content signal after autocomplete inserts text
              if (textareaRef) setContent(textareaRef.value);
            }}
          />
        </TextField>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium">{t`Language`}</label>
          <LanguageSelect
            value={language()}
            onChange={handleLanguageChange}
          />
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium">{t`Visibility`}</label>
          <PostVisibilitySelect
            value={visibility()}
            onChange={setVisibility}
          />
        </div>
        <div class="flex gap-2 justify-end">
          <Show when={props.showCancelButton}>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onCancel?.()}
              disabled={isCreating()}
            >
              {t`Cancel`}
            </Button>
          </Show>
          <Button
            type="submit"
            disabled={isCreating() || (!!props.quotedPostId && !quotedPost())}
          >
            <Show when={isCreating()} fallback={t`Create Note`}>
              {t`Creating…`}
            </Show>
          </Button>
        </div>
      </div>
    </form>
  );
}

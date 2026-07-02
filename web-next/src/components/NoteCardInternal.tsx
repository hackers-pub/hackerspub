import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { createDeferredRender } from "~/lib/deferredRender.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";
import { CensorshipNotice } from "./CensorshipNotice.tsx";
import { LinkPreview } from "./LinkPreview.tsx";
import { NoteHeader } from "./NoteHeader.tsx";
import { NoteMedia } from "./NoteMedia.tsx";
import { PostAuthorAvatar } from "./PostAuthor.tsx";
import { PostEngagementBar } from "./PostEngagementBar.tsx";
import type { PostVisibility } from "./PostVisibilitySelect.tsx";
import type { QuotePolicy } from "./QuotePolicySelect.tsx";
import { QuoteTargetPlaceholder } from "./QuoteTargetPlaceholder.tsx";
import { QuotedPostCard } from "./QuotedPostCard.tsx";
import { Button } from "./ui/button.tsx";

export interface NoteCardInternalProps {
  $note: NoteCardInternal_note$key;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
}

export function NoteCardInternal(props: NoteCardInternalProps) {
  const { t } = useLingui();
  const viewer = useViewer();
  const { openForEdit } = useNoteCompose();
  const liveNote = createFragment(
    graphql`
      fragment NoteCardInternal_note on Note
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        __id
        id
        uuid
        sourceId
        viewerCanRevokeQuote(actingAccountId: $actingAccountId)
        censored
        content
        language
        personalRawContent: rawContent
        rawContent(actingAccountId: $actingAccountId)
        sensitive
        summary
        quotePolicy
        visibility
        actor {
          local
          username
          handle
          isViewer(actingAccountId: $actingAccountId)
          account {
            id
            kind
          }
        }
        ...PostAuthorAvatar_post
        ...PostEngagementBar_post @arguments(
          actingAccountId: $actingAccountId
        )
        ...NoteMedia_note
        ...LinkPreview_note @arguments(actingAccountId: $actingAccountId)
        ...NoteHeader_note
        quoteTargetState
        quotedPost(actingAccountId: $actingAccountId) {
          ...QuotedPostCard_post
        }
      }
    `,
    () => props.$note,
  );
  const fragmentKey = () => {
    const note = props.$note as
      | {
        readonly __id?: string;
        readonly id?: string;
      }
      | null
      | undefined;
    return note?.id ?? note?.__id ?? null;
  };
  const stableNote = createMemo<
    {
      key: string;
      value: NonNullable<ReturnType<typeof liveNote>>;
    } | null
  >((previous) => {
    const value = liveNote();
    const key = value?.id ?? value?.__id ?? fragmentKey();
    if (value != null && key != null) return { key, value };
    return previous?.key === key ? previous : null;
  });
  const note = () => stableNote()?.value ?? null;

  // Local permalink base for the engagement bar.  Local notes use the
  // source row's UUID (matching the URL embedded in `Post.url`);
  // remote notes fall back to the post row's UUID, which is the
  // internal route token.  Both `repliesHref` and `engagementBase`
  // build on the same base.
  const permalinkBase = () => {
    const n = note();
    if (!n) return null;
    const actorSegment = n.actor.local
      ? `@${n.actor.username}`
      : encodeHandleSegment(n.actor.handle);
    const id = n.sourceId ?? n.uuid;
    return `/${actorSegment}/${id}`;
  };
  const repliesHref = () => {
    const base = permalinkBase();
    return base == null ? null : `${base}/replies`;
  };

  const [cwRevealed, setCwRevealed] = createSignal(false);
  const hasCW = () => !!note()?.summary;
  const contentVisible = () => !hasCW() || cwRevealed();

  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);
  useContentLinkInterceptor(proseRef);
  const showDeferredSections = createDeferredRender(() =>
    !!props.deferHeavySections
  );

  return (
    <Show keyed when={note()}>
      {(n) => (
        <div class="flex gap-3 sm:gap-4">
          <PostAuthorAvatar $post={n} />
          <div class="min-w-0 grow">
            <NoteHeader
              $note={n}
            />
            <Show when={n.censored}>
              <CensorshipNotice
                class="mt-1"
                privileged={n.actor.isViewer || viewer.moderator()}
              />
            </Show>
            <Show when={n.summary}>
              <div class="mt-1 flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
                <p class="grow text-sm text-muted-foreground">
                  <strong class="font-semibold text-foreground">
                    {t`CW`}:
                  </strong>{" "}
                  {n.summary}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCwRevealed((v) => !v)}
                >
                  {cwRevealed() ? t`Hide` : t`Show`}
                </Button>
              </div>
            </Show>
            <Show when={contentVisible()}>
              <div
                ref={setProseRef}
                innerHTML={n.content}
                lang={n.language ?? undefined}
                class="prose dark:prose-invert mt-1 break-words overflow-wrap"
              />
              <Show when={showDeferredSections()}>
                <NoteMedia $note={n} postSensitive={n.sensitive} />
                <LinkPreview $note={n} />
                {
                  /* `keyed`: avoid Solid's stale-accessor race when this
                   Relay field flips to null inside a `batch()` update. */
                }
                <Show keyed when={n.quotedPost}>
                  {(quotedPost) => (
                    <QuotedPostCard
                      $post={quotedPost}
                      quotePostId={n.id}
                      canRevokeQuote={n.viewerCanRevokeQuote}
                    />
                  )}
                </Show>
                <Show
                  keyed
                  when={n.quotedPost == null ? n.quoteTargetState : null}
                >
                  {(state) => <QuoteTargetPlaceholder state={state} />}
                </Show>
              </Show>
            </Show>
            <Show when={showDeferredSections()}>
              <MentionHoverCardLayer state={mentionState} />
              <PostEngagementBar
                $post={n}
                repliesHref={repliesHref()}
                engagementBase={permalinkBase()}
                connections={props.connections}
                pinConnections={props.pinConnections}
                bookmarkListConnections={props.bookmarkListConnections}
                onDeleted={props.onDeleted}
                onEdit={(n.rawContent ?? n.personalRawContent) != null &&
                    n.visibility !== "NONE"
                  ? () =>
                    openForEdit(n.id, {
                      content: (n.rawContent ?? n.personalRawContent)!,
                      language: n.language,
                      quotePolicy: (n.quotePolicy as QuotePolicy) ?? "EVERYONE",
                      visibility: (n.visibility as PostVisibility) ?? "PUBLIC",
                      authorAccountId: n.rawContent != null &&
                          n.actor.account?.kind === "ORGANIZATION"
                        ? n.actor.account.id
                        : null,
                    })
                  : undefined}
              />
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

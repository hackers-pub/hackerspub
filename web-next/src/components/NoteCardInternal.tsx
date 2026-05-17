import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";
import { LinkPreview } from "./LinkPreview.tsx";
import { NoteHeader } from "./NoteHeader.tsx";
import { NoteMedia } from "./NoteMedia.tsx";
import { PostAvatar } from "./PostAvatar.tsx";
import { PostEngagementBar } from "./PostEngagementBar.tsx";
import { QuoteTargetPlaceholder } from "./QuoteTargetPlaceholder.tsx";
import { QuotedPostCard } from "./QuotedPostCard.tsx";

export interface NoteCardInternalProps {
  $note: NoteCardInternal_note$key;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  onDeleted?: () => void;
}

export function NoteCardInternal(props: NoteCardInternalProps) {
  const note = createFragment(
    graphql`
      fragment NoteCardInternal_note on Note {
        __id
        id
        uuid
        sourceId
        viewerCanRevokeQuote
        content
        language
        actor {
          local
          username
          handle
          ...PostAvatar_actor
        }
        ...PostEngagementBar_post
        ...NoteMedia_note
        ...LinkPreview_note
        ...NoteHeader_note
        quoteTargetState
        quotedPost {
          ...QuotedPostCard_post
        }
      }
    `,
    () => props.$note,
  );

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

  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);

  return (
    <Show keyed when={note()}>
      {(n) => (
        <div class="flex gap-3 sm:gap-4">
          <PostAvatar $actor={n.actor} />
          <div class="min-w-0 grow">
            <NoteHeader
              $note={n}
              connections={props.connections}
              pinConnections={props.pinConnections}
              onDeleted={props.onDeleted}
            />
            <div
              ref={setProseRef}
              innerHTML={n.content}
              lang={n.language ?? undefined}
              class="prose dark:prose-invert mt-1 break-words overflow-wrap"
            />
            <MentionHoverCardLayer state={mentionState} />
            <NoteMedia $note={n} />
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
            <Show keyed when={n.quotedPost == null ? n.quoteTargetState : null}>
              {(state) => <QuoteTargetPlaceholder state={state} />}
            </Show>
            <PostEngagementBar
              $post={n}
              repliesHref={repliesHref()}
              engagementBase={permalinkBase()}
              bookmarkListConnections={props.bookmarkListConnections}
            />
          </div>
        </div>
      )}
    </Show>
  );
}

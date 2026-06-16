import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteHeader_note$key } from "./__generated__/NoteHeader_note.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { InternalLink } from "./InternalLink.tsx";
import { PostActionMenu } from "./PostActionMenu.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { VisibilityTag } from "./VisibilityTag.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";

export interface NoteHeaderProps {
  $note: NoteHeader_note$key;
  connections?: string[];
  pinConnections?: string[];
  repliesHref?: string | null;
  engagementBase?: string | null;
  onDeleted?: () => void;
}

export function NoteHeader(props: NoteHeaderProps) {
  const { openForEdit } = useNoteCompose();
  const note = createFragment(
    graphql`
      fragment NoteHeader_note on Note {
        id
        uuid
        sourceId
        visibility
        published
        url
        iri
        rawContent
        language
        quotePolicy
        actor {
          name
          handle
          username
          local
          url
          iri
          isViewer
        }
        ...PostActionMenu_post
      }
    `,
    () => props.$note,
  );

  return (
    <Show keyed when={note()}>
      {(n) => (
        <div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
          <ActorHoverCard
            handle={n.actor.handle}
            class="min-w-0 grow flex flex-wrap items-baseline gap-x-1"
          >
            <Show when={(n.actor.name ?? "").trim() !== ""}>
              <InternalLink
                href={n.actor.url ?? n.actor.iri}
                internalHref={n.actor.local
                  ? `/@${n.actor.username}`
                  : `/${n.actor.handle}`}
                innerHTML={n.actor.name ?? ""}
                class="font-semibold"
              />
            </Show>
            <span
              class="min-w-0 truncate select-all text-muted-foreground"
              title={n.actor.handle}
            >
              {n.actor.handle}
            </span>
          </ActorHoverCard>
          <span class="flex items-center gap-1.5 text-sm text-muted-foreground/70">
            <InternalLink
              href={n.url ?? n.iri}
              internalHref={`/${
                n.actor.local ? "@" + n.actor.username : n.actor.handle
              }/${n.sourceId ?? n.uuid}`}
            >
              <Timestamp value={n.published} capitalizeFirstLetter />
            </InternalLink>
            &middot;
            <VisibilityTag visibility={n.visibility} />
            <PostActionMenu
              $post={n}
              connections={props.connections}
              pinConnections={props.pinConnections}
              repliesHref={props.repliesHref}
              engagementBase={props.engagementBase}
              onDeleted={props.onDeleted}
              onEdit={n.rawContent != null && n.visibility !== "NONE"
                ? () =>
                  openForEdit(n.id, {
                    content: n.rawContent!,
                    language: n.language,
                    quotePolicy: (n.quotePolicy as QuotePolicy) ?? "EVERYONE",
                    visibility: (n.visibility as PostVisibility) ?? "PUBLIC",
                  })
                : undefined}
            />
          </span>
        </div>
      )}
    </Show>
  );
}

import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { ActorHoverCard } from "~/components/ActorHoverCard.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { VisibilityTag } from "~/components/VisibilityTag.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import IconBan from "~icons/lucide/ban";
import type { QuotedNoteCard_note$key } from "./__generated__/QuotedNoteCard_note.graphql.ts";
import type { QuotedNoteCardRevokeQuoteMutation } from "./__generated__/QuotedNoteCardRevokeQuoteMutation.graphql.ts";

const RevokeQuoteMutation = graphql`
  mutation QuotedNoteCardRevokeQuoteMutation($input: RevokeQuoteInput!) {
    revokeQuote(input: $input) {
      __typename
      ... on RevokeQuotePayload {
        quote {
          id
          viewerCanRevokeQuote
          quotedPost {
            id
          }
        }
        quotedPost {
          id
          engagementStats {
            quotes
          }
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

export interface QuotedNoteCardProps {
  readonly $note: QuotedNoteCard_note$key;
  readonly quotePostId?: string;
  readonly canRevokeQuote?: boolean;
  readonly class?: string;
  readonly classList?: { [k: string]: boolean | undefined };
}

export function QuotedNoteCard(props: QuotedNoteCardProps) {
  const { t } = useLingui();
  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);
  const [revokeQuote, revoking] = createMutation<
    QuotedNoteCardRevokeQuoteMutation
  >(RevokeQuoteMutation);

  const note = createFragment(
    graphql`
      fragment QuotedNoteCard_note on Note {
        __id
        uuid
        sourceId
        actor {
          name
          handle
          username
          avatarUrl
          local
          url
          iri
        }
        content
        language
        visibility
        published
        url
        iri
      }
    `,
    () => props.$note,
  );

  return (
    <Show keyed when={note()}>
      {(note) => (
        <div class={props.class} classList={props.classList}>
          <div class="w-0 h-0 border-l-[15px] border-r-[15px] border-b-[20px] border-l-transparent border-r-transparent border-b-muted ml-4" />
          <div class="flex flex-col bg-muted p-4">
            <div class="flex min-w-0 gap-4">
              <ActorHoverCard handle={note.actor.handle} class="shrink-0">
                <Avatar class="size-12 shrink-0">
                  <InternalLink
                    href={note.actor.url ?? note.actor.iri}
                    internalHref={note.actor.local
                      ? `/@${note.actor.username}`
                      : `/${note.actor.handle}`}
                  >
                    <AvatarImage src={note.actor.avatarUrl} class="size-12" />
                  </InternalLink>
                </Avatar>
              </ActorHoverCard>
              <div class="flex min-w-0 flex-col">
                <ActorHoverCard
                  handle={note.actor.handle}
                  class="min-w-0 flex flex-wrap items-baseline gap-x-1"
                >
                  <Show when={(note.actor.name ?? "").trim() !== ""}>
                    <InternalLink
                      href={note.actor.url ?? note.actor.iri}
                      internalHref={note.actor.local
                        ? `/@${note.actor.username}`
                        : `/${note.actor.handle}`}
                      innerHTML={note.actor.name ?? ""}
                      class="font-semibold"
                    />
                  </Show>
                  <span
                    class="min-w-0 break-all select-all text-muted-foreground"
                    title={note.actor.handle}
                  >
                    {note.actor.handle}
                  </span>
                </ActorHoverCard>
                <div class="flex min-w-0 flex-row flex-wrap gap-1 text-muted-foreground">
                  <InternalLink
                    href={note.url ?? note.iri}
                    internalHref={note.actor.local
                      ? `/@${note.actor.username}/${note.sourceId ?? note.uuid}`
                      : `/${note.actor.handle}/${note.sourceId ?? note.uuid}`}
                  >
                    <Timestamp value={note.published} capitalizeFirstLetter />
                  </InternalLink>{" "}
                  &middot; <VisibilityTag visibility={note.visibility} />
                </div>
              </div>
            </div>
            <div
              ref={setProseRef}
              innerHTML={note.content}
              lang={note.language ?? undefined}
              class="prose dark:prose-invert break-words overflow-wrap px-4 pt-4"
            />
            <MentionHoverCardLayer state={mentionState} />
            <Show when={props.canRevokeQuote && props.quotePostId != null}>
              <div class="mt-3 flex justify-end border-t border-border/60 pt-3">
                <AlertDialog>
                  <AlertDialogTrigger
                    as={Button}
                    variant="outline"
                    size="sm"
                    disabled={revoking()}
                  >
                    <IconBan class="size-4" />
                    {t`Revoke quote`}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t`Revoke this quote?`}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t`The quoting post will no longer include your post as a quote.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose>{t`Cancel`}</AlertDialogClose>
                      <AlertDialogAction
                        disabled={revoking()}
                        onClick={() => {
                          if (revoking()) return;
                          const quotePostId = props.quotePostId;
                          if (quotePostId == null) return;
                          revokeQuote({
                            variables: {
                              input: { quotePostId },
                            },
                            onCompleted(response) {
                              if (
                                response.revokeQuote.__typename ===
                                  "RevokeQuotePayload"
                              ) {
                                showToast({
                                  title: t`Quote revoked`,
                                  variant: "success",
                                });
                              } else {
                                showToast({
                                  title: t`Error`,
                                  description: t`Could not revoke quote`,
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
                        }}
                      >
                        {t`Revoke quote`}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

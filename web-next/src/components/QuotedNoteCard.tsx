import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { CensorshipNotice } from "~/components/CensorshipNotice.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { PostAuthorAvatar, PostAuthorLine } from "~/components/PostAuthor.tsx";
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
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { VisibilityTag } from "~/components/VisibilityTag.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import IconBan from "~icons/lucide/ban";
import IconVolumeX from "~icons/lucide/volume-x";
import type {
  QuotedNoteCard_post$data,
  QuotedNoteCard_post$key,
} from "./__generated__/QuotedNoteCard_post.graphql.ts";
import type { QuotedNoteCardRevokeQuoteMutation } from "./__generated__/QuotedNoteCardRevokeQuoteMutation.graphql.ts";

const RevokeQuoteMutation = graphql`
  mutation QuotedNoteCardRevokeQuoteMutation(
    $input: RevokeQuoteInput!
    $actingAccountId: ID
  ) {
    revokeQuote(input: $input) {
      __typename
      ... on RevokeQuotePayload {
        quote {
          id
          viewerCanRevokeQuote(actingAccountId: $actingAccountId)
          quoteTargetState
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
  readonly $post: QuotedNoteCard_post$key;
  readonly quotePostId?: string;
  readonly canRevokeQuote?: boolean;
  readonly class?: string;
  readonly classList?: { [k: string]: boolean | undefined };
}

export function QuotedNoteCard(props: QuotedNoteCardProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const { preferAiSummary, moderator } = useViewer();
  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);
  useContentLinkInterceptor(proseRef);
  const [revokeQuote, revoking] = createMutation<
    QuotedNoteCardRevokeQuoteMutation
  >(RevokeQuoteMutation);

  const post = createFragment(
    graphql`
      fragment QuotedNoteCard_post on Post {
        __typename
        __id
        uuid
        censored
        ... on Note {
          sourceId
          content
          language
        }
        ... on Question {
          content
          language
        }
        ... on Article {
          name
          excerptHtml(maxChars: 800)
        }
        actor {
          name
          handle
          username
          avatarUrl
          local
          isViewer
          url
          iri
          viewerMutes
        }
        ...PostAuthorAvatar_post
        ...PostAuthorLine_post
        sensitive
        summary
        visibility
        published
        url
        iri
      }
    `,
    () => props.$post,
  );

  const [cwRevealed, setCwRevealed] = createSignal(false);
  const [muteRevealed, setMuteRevealed] = createSignal(false);
  // For Articles, `summary` is an article/LLM description, not a CW field.
  // Only treat `summary` as CW for Note/Question types.
  const hasCW = () => {
    const p = post();
    if (!p) return false;
    if (p.__typename === "Article") return !!p.sensitive;
    return !!p.summary;
  };
  const contentVisible = () => !hasCW() || cwRevealed();
  const articleSummary = (post: QuotedNoteCard_post$data) =>
    post.__typename === "Article" &&
      (post.actor.local ? preferAiSummary() : true)
      ? post.summary
      : null;

  return (
    <Show keyed when={post()}>
      {(post) => (
        <div class={props.class} classList={props.classList}>
          <div class="w-0 h-0 border-l-[15px] border-r-[15px] border-b-[20px] border-l-transparent border-r-transparent border-b-muted ml-4" />
          <Show
            when={!post.actor?.viewerMutes || muteRevealed()}
            fallback={
              <div class="flex items-center gap-3 bg-muted p-4 text-sm text-muted-foreground">
                <IconVolumeX class="size-4 shrink-0" />
                <p class="grow min-w-0">
                  {t`This quoted post is hidden because you muted ${post.actor.handle}.`}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0 cursor-pointer"
                  onClick={() => setMuteRevealed(true)}
                >
                  {t`Show`}
                </Button>
              </div>
            }
          >
            <div class="flex flex-col bg-muted p-4">
              <div class="flex min-w-0 gap-4">
                <PostAuthorAvatar $post={post} size="large" />
                <div class="flex min-w-0 flex-col">
                  <PostAuthorLine $post={post} handleClass="break-all" />
                  <div class="flex min-w-0 flex-row flex-wrap gap-1 text-muted-foreground">
                    <InternalLink
                      href={post.url ?? post.iri}
                      internalHref={getQuotedPostInternalHref(post)}
                    >
                      <Timestamp value={post.published} capitalizeFirstLetter />
                    </InternalLink>{" "}
                    &middot; <VisibilityTag visibility={post.visibility} />
                  </div>
                </div>
              </div>
              <Show when={post.censored}>
                <CensorshipNotice
                  class="mt-3"
                  privileged={post.actor.isViewer || moderator()}
                />
              </Show>
              <Show when={hasCW()}>
                <div class="mt-3 flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                  <p class="grow text-sm text-muted-foreground">
                    <strong class="font-semibold text-foreground">
                      {t`CW`}:
                    </strong>{" "}
                    {post.__typename !== "Article" && post.summary
                      ? post.summary
                      : t`Sensitive content`}
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
                <Show
                  when={post.__typename === "Article"}
                  fallback={
                    <>
                      <div
                        ref={setProseRef}
                        innerHTML={post.content}
                        lang={post.language ?? undefined}
                        class="prose dark:prose-invert break-words overflow-wrap px-4 pt-4"
                      />
                      <MentionHoverCardLayer state={mentionState} />
                    </>
                  }
                >
                  <div class="px-4 pt-4">
                    <Show when={post.name}>
                      <InternalLink
                        href={post.url ?? post.iri}
                        internalHref={getQuotedPostInternalHref(post)}
                        class="block text-lg font-semibold leading-snug"
                      >
                        {post.name}
                      </InternalLink>
                    </Show>
                    <Show
                      keyed
                      when={articleSummary(post)}
                      fallback={
                        <InternalLink
                          href={post.url ?? post.iri}
                          internalHref={getQuotedPostInternalHref(post)}
                          class="mt-3 block"
                        >
                          <div
                            innerHTML={post.excerptHtml}
                            class="line-clamp-4 overflow-hidden"
                          />
                        </InternalLink>
                      }
                    >
                      {(summary) => (
                        <InternalLink
                          href={post.url ?? post.iri}
                          internalHref={getQuotedPostInternalHref(post)}
                          innerHTML={summary}
                          data-llm-summary-label={t`Summarized by LLM`}
                          class="prose dark:prose-invert break-words overflow-wrap mt-3 block before:content-[attr(data-llm-summary-label)] before:mr-1 before:rounded-sm before:border before:bg-background before:p-1 before:text-sm before:text-muted-foreground"
                        />
                      )}
                    </Show>
                  </div>
                </Show>
              </Show>
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
                            const actingAccountId = actingAccount
                              .selectedActingAccountId();
                            revokeQuote({
                              variables: {
                                input: {
                                  quotePostId,
                                  ...(actingAccountId == null
                                    ? {}
                                    : { actingAccountId }),
                                },
                                actingAccountId: actingAccountId ?? null,
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
          </Show>
        </div>
      )}
    </Show>
  );
}

function getQuotedPostInternalHref(post: QuotedNoteCard_post$data): string {
  if (post.actor.local && post.url != null) {
    try {
      const url = new URL(post.url);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      // Fall through to the row-based route if a legacy row has a bad URL.
    }
  }
  const actorSegment = post.actor.local
    ? `@${post.actor.username}`
    : post.actor.handle;
  const postId = post.__typename === "Note"
    ? post.sourceId ?? post.uuid
    : post.uuid;
  return `/${actorSegment}/${postId}`;
}

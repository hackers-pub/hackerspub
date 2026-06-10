import { graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import IconCheckSquare from "~icons/lucide/square-check-big";
import IconCircle from "~icons/lucide/circle";
import IconListChecks from "~icons/lucide/list-checks";
import IconRadio from "~icons/lucide/circle-dot";
import IconSquare from "~icons/lucide/square";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { createDeferredRender } from "~/lib/deferredRender.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import type { QuestionCard_question$key } from "./__generated__/QuestionCard_question.graphql.ts";
import type { QuestionCardContent_question$key } from "./__generated__/QuestionCardContent_question.graphql.ts";
import type { QuestionCard_voteOnPoll_Mutation } from "./__generated__/QuestionCard_voteOnPoll_Mutation.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { ActorSharer, ActorSharerActor } from "./ActorSharer.tsx";
import { InternalLink } from "./InternalLink.tsx";
import { QuestionActionMenu } from "./PostActionMenu.tsx";
import { PostAvatar } from "./PostAvatar.tsx";
import { PostEngagementBar } from "./PostEngagementBar.tsx";
import { QuoteTargetPlaceholder } from "./QuoteTargetPlaceholder.tsx";
import { QuotedPostCard } from "./QuotedPostCard.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";
import { VisibilityTag } from "./VisibilityTag.tsx";

export interface QuestionCardProps {
  $question: QuestionCard_question$key;
  sharerActor?: ActorSharerActor | null;
  sharerTimestamp?: string | null;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
}

export function QuestionCard(props: QuestionCardProps) {
  const question = createFragment(
    graphql`
      fragment QuestionCard_question on Question {
        actor {
          name
          local
          username
          handle
        }
        published
        ...QuestionCardContent_question
        sharedPost {
          __typename
          ... on Question {
            ...QuestionCardContent_question
          }
        }
      }
    `,
    () => props.$question,
  );
  const { t } = useLingui();

  return (
    <Show keyed when={question()}>
      {(q) => {
        const sharedQuestion = (): QuestionCardContent_question$key | null => {
          const sharedPost = q.sharedPost;
          return sharedPost?.__typename === "Question" ? sharedPost : null;
        };
        return (
          <article class="border-b px-4 py-4 transition-colors hover:bg-muted/30 last:border-none">
            <div class="flex flex-col gap-0.5">
              <Show when={sharedQuestion()}>
                <p class="ml-14 text-sm text-muted-foreground">
                  <Trans
                    message={t`${"SHARER"} shared ${"RELATIVE_TIME"}`}
                    values={{
                      SHARER: () => (
                        <ActorHoverCard handle={q.actor.handle}>
                          <a
                            href={`/${
                              q.actor.local
                                ? `@${q.actor.username}`
                                : q.actor.handle
                            }`}
                            class="font-semibold"
                          >
                            {q.actor.name}
                          </a>
                        </ActorHoverCard>
                      ),
                      RELATIVE_TIME: () => <Timestamp value={q.published} />,
                    }}
                  />
                </p>
              </Show>
              <Show when={props.sharerActor}>
                <ActorSharer
                  actor={props.sharerActor!}
                  timestamp={props.sharerTimestamp!}
                  class="ml-14"
                />
              </Show>
              <QuestionCardContent
                $question={sharedQuestion() ?? q}
                connections={props.connections}
                bookmarkListConnections={props.bookmarkListConnections}
                pinConnections={props.pinConnections}
                deferHeavySections={props.deferHeavySections}
                onDeleted={props.onDeleted}
              />
            </div>
          </article>
        );
      }}
    </Show>
  );
}

interface QuestionCardContentProps {
  $question: QuestionCardContent_question$key;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
}

function QuestionCardContent(props: QuestionCardContentProps) {
  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);
  const showDeferredSections = createDeferredRender(() =>
    !!props.deferHeavySections
  );

  const question = createFragment(
    graphql`
      fragment QuestionCardContent_question on Question {
        __id
        id
        uuid
        sourceId
        content
        language
        visibility
        published
        url
        iri
        actor {
          name
          handle
          username
          local
          url
          iri
          ...PostAvatar_actor
        }
        poll {
          multiple
          closed
          ends
          viewerHasVoted
          voters(first: 0) {
            totalCount
          }
          votes(first: 0) {
            totalCount
          }
          options {
            index
            title
            viewerHasVoted
            votes(first: 0) {
              totalCount
            }
          }
        }
        viewerCanRevokeQuote
        quoteTargetState
        quotedPost {
          ...QuotedPostCard_post
        }
        ...PostActionMenu_question
        ...PostEngagementBar_post
      }
    `,
    () => props.$question,
  );
  const { i18n, t } = useLingui();
  const viewer = useViewer();
  const [selectedOptions, setSelectedOptions] = createSignal<
    ReadonlySet<
      number
    >
  >(new Set());
  const [voteOnPoll, isVoting] = createMutation<
    QuestionCard_voteOnPoll_Mutation
  >(
    graphql`
      mutation QuestionCard_voteOnPoll_Mutation($input: VoteOnPollInput!) {
        voteOnPoll(input: $input) {
          __typename
          ... on VoteOnPollPayload {
            question {
              ...QuestionCard_question
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
    `,
  );

  createEffect(() => {
    const poll = question()?.poll;
    if (poll?.viewerHasVoted) {
      setSelectedOptions(
        new Set(
          poll.options
            .filter((option) => option.viewerHasVoted)
            .map((option) => option.index),
        ),
      );
    }
  });

  return (
    <Show keyed when={question()}>
      {(q) => (
        <div class="flex gap-4">
          <PostAvatar $actor={q.actor} />
          <div class="min-w-0 grow">
            <div class="flex items-center gap-1 flex-wrap">
              <ActorHoverCard
                handle={q.actor.handle}
                class="min-w-0 grow flex flex-wrap items-baseline gap-x-1"
              >
                <Show when={(q.actor.name ?? "").trim() !== ""}>
                  <InternalLink
                    href={q.actor.url ?? q.actor.iri}
                    internalHref={q.actor.local
                      ? `/@${q.actor.username}`
                      : `/${q.actor.handle}`}
                    innerHTML={q.actor.name ?? ""}
                    class="font-semibold"
                  />
                </Show>
                <span
                  class="min-w-0 truncate select-all text-muted-foreground"
                  title={q.actor.handle}
                >
                  {q.actor.handle}
                </span>
              </ActorHoverCard>
              <span class="flex items-center text-sm text-muted-foreground/60 gap-1.5">
                <InternalLink
                  href={q.url ?? q.iri}
                  internalHref={`/${
                    q.actor.local ? "@" + q.actor.username : q.actor.handle
                  }/${q.sourceId ?? q.uuid}`}
                >
                  <Timestamp value={q.published} capitalizeFirstLetter />
                </InternalLink>
                &middot;
                <VisibilityTag visibility={q.visibility} />
                <Show when={showDeferredSections()}>
                  <QuestionActionMenu
                    $question={q}
                    connections={props.connections}
                    pinConnections={props.pinConnections}
                    onDeleted={props.onDeleted}
                  />
                </Show>
              </span>
            </div>
            <div
              ref={setProseRef}
              innerHTML={q.content}
              lang={q.language ?? undefined}
              class="prose dark:prose-invert break-words overflow-wrap"
            />
            <Show when={showDeferredSections()}>
              <MentionHoverCardLayer state={mentionState} />
              {
                /* `keyed`: avoid Solid's stale-accessor race when this
                 Relay field flips to null inside a `batch()` update. */
              }
              <Show keyed when={q.poll}>
                {(poll) => (
                  <PollPanel
                    questionId={q.id}
                    poll={poll}
                  />
                )}
              </Show>
              {
                /* `keyed`: avoid Solid's stale-accessor race when this
                 Relay field flips to null inside a `batch()` update. */
              }
              <Show keyed when={q.quotedPost}>
                {(quotedPost) => (
                  <QuotedPostCard
                    $post={quotedPost}
                    quotePostId={q.id}
                    canRevokeQuote={q.viewerCanRevokeQuote}
                  />
                )}
              </Show>
              <Show
                keyed
                when={q.quotedPost == null ? q.quoteTargetState : null}
              >
                {(state) => <QuoteTargetPlaceholder state={state} />}
              </Show>
              {(() => {
                const base = `/${
                  q.actor.local
                    ? `@${q.actor.username}`
                    : encodeHandleSegment(q.actor.handle)
                }/${q.sourceId ?? q.uuid}`;
                return (
                  <PostEngagementBar
                    $post={q}
                    repliesHref={`${base}/replies`}
                    engagementBase={base}
                    bookmarkListConnections={props.bookmarkListConnections}
                  />
                );
              })()}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );

  function PollPanel(props: {
    questionId: string;
    poll: NonNullable<NonNullable<ReturnType<typeof question>>["poll"]>;
  }) {
    const [now, setNow] = createSignal(Date.now());
    const endsAt = () => new Date(props.poll.ends).getTime();
    const isClosed = () => props.poll.closed || endsAt() <= now();
    const totalVotes = createMemo(() =>
      props.poll.options.reduce(
        (sum, option) => sum + Math.max(option.votes.totalCount, 0),
        0,
      )
    );
    const percent = (count: number) => {
      const denominator = totalVotes();
      return denominator < 1 ? 0 : Math.round((count / denominator) * 100);
    };
    const canVote = () =>
      viewer.isAuthenticated() && !isClosed() &&
      !props.poll.viewerHasVoted && !isVoting();
    const hasSelection = () => selectedOptions().size > 0;
    const isSelected = (index: number, viewerHasVoted: boolean) =>
      props.poll.viewerHasVoted ? viewerHasVoted : selectedOptions().has(index);
    const toggleOption = (index: number) => {
      if (!canVote()) return;
      if (props.poll.multiple) {
        setSelectedOptions((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      } else {
        setSelectedOptions(new Set([index]));
      }
    };
    const actionLabel = () => {
      if (isClosed()) return t`Poll closed`;
      if (props.poll.viewerHasVoted) return t`Voted`;
      if (!viewer.isAuthenticated()) return t`Sign in to vote`;
      if (isVoting()) return t`Voting…`;
      if (!hasSelection()) {
        return props.poll.multiple ? t`Select options` : t`Select an option`;
      }
      return t`Vote`;
    };
    const submitVote = () => {
      if (!canVote() || !hasSelection()) return;
      voteOnPoll({
        variables: {
          input: {
            questionId: props.questionId,
            optionIndices: [...selectedOptions()].sort((a, b) => a - b),
          },
        },
        onCompleted(response) {
          switch (response.voteOnPoll.__typename) {
            case "VoteOnPollPayload":
              showToast({ title: t`Vote recorded` });
              break;
            case "NotAuthenticatedError":
              showToast({
                title: t`Please sign in to vote`,
                variant: "destructive",
              });
              break;
            default:
              showToast({
                title: t`Could not vote on this poll`,
                variant: "destructive",
              });
              break;
          }
        },
        onError() {
          showToast({
            title: t`Failed to vote`,
            variant: "destructive",
          });
        },
      });
    };

    createEffect(() => {
      const delay = endsAt() - now();
      if (!Number.isFinite(delay) || delay <= 0) return;

      const timeout = setTimeout(
        () => setNow(Date.now()),
        Math.min(delay, 2_147_483_647),
      );
      onCleanup(() => clearTimeout(timeout));
    });

    return (
      <section
        class="my-3 rounded-lg border bg-background/80 p-3"
        classList={{
          "border-primary/30": !isClosed() && !props.poll.multiple,
          "border-emerald-500/35": !isClosed() &&
            props.poll.multiple,
          "border-muted bg-muted/20 text-muted-foreground": isClosed(),
        }}
      >
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={props.poll.multiple ? "success" : "secondary"}>
            <Show
              when={props.poll.multiple}
              fallback={<IconRadio class="mr-1 size-3.5" />}
            >
              <IconListChecks class="mr-1 size-3.5" />
            </Show>
            {props.poll.multiple ? t`Multiple choice` : t`Single choice`}
          </Badge>
          <Badge variant={isClosed() ? "outline" : "secondary"}>
            {isClosed() ? t`Closed` : t`Open`}
          </Badge>
          <span class="text-muted-foreground">
            {isClosed() ? t`Ended` : t`Ends`}{" "}
            <Timestamp value={props.poll.ends} allowFuture />
          </span>
          <span class="text-muted-foreground">
            &middot; {i18n._(
              msg`${
                plural(props.poll.voters.totalCount, {
                  one: "# voter",
                  other: "# voters",
                })
              }`,
            )}
          </span>
        </div>
        <div class="mt-3 space-y-2">
          <For each={props.poll.options}>
            {(option) => {
              const votes = () => option.votes.totalCount;
              const selected = () =>
                isSelected(option.index, option.viewerHasVoted);
              return (
                <button
                  type="button"
                  aria-pressed={selected()}
                  disabled={!canVote()}
                  onClick={() => toggleOption(option.index)}
                  class="relative w-full overflow-hidden rounded-md border bg-card text-left transition-colors disabled:cursor-default"
                  classList={{
                    "hover:border-primary/60 hover:bg-accent/40 cursor-pointer":
                      canVote(),
                    "border-primary/60": selected() && !isClosed(),
                  }}
                >
                  <div
                    class="absolute inset-y-0 left-0 bg-primary/10 transition-[width]"
                    classList={{
                      "bg-emerald-500/15": props.poll.multiple,
                      "bg-muted": isClosed(),
                      "bg-primary/20": selected() && !props.poll.multiple,
                    }}
                    style={{ width: `${percent(votes())}%` }}
                  />
                  <div class="relative flex min-h-10 items-center gap-2 px-3 py-2 text-sm">
                    <Show
                      when={selected()}
                      fallback={props.poll.multiple
                        ? <IconSquare class="size-4 text-muted-foreground" />
                        : <IconCircle class="size-4 text-muted-foreground" />}
                    >
                      {props.poll.multiple
                        ? <IconCheckSquare class="size-4 text-primary" />
                        : <IconRadio class="size-4 text-primary" />}
                    </Show>
                    <span class="min-w-0 grow break-words">{option.title}</span>
                    <span class="shrink-0 tabular-nums text-muted-foreground">
                      {percent(votes())}%
                    </span>
                    <span class="shrink-0 tabular-nums text-muted-foreground">
                      {i18n._(
                        msg`${
                          plural(votes(), {
                            one: "# vote",
                            other: "# votes",
                          })
                        }`,
                      )}
                    </span>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
        <div class="mt-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!canVote() || !hasSelection()}
            onClick={submitVote}
            class={canVote() && hasSelection() ? "cursor-pointer" : undefined}
          >
            {actionLabel()}
          </Button>
        </div>
      </section>
    );
  }
}

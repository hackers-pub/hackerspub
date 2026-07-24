import * as vocab from "@fedify/vocab";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { addExternalLinkTargets } from "@hackerspub/models/html";
import { OrganizationPermissionError } from "@hackerspub/models/organization";
import { vote } from "@hackerspub/models/poll";
import {
  getSanctionVisibleActorFilter,
  isActorSanctionHidden,
  isPostVisibleTo,
} from "@hackerspub/models/post/visibility";
import { persistPost } from "@hackerspub/models/post/remote";
import {
  type Actor as ActorRow,
  actorTable,
  pollVoteTable,
} from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import DataLoader from "dataloader";
import {
  and,
  count,
  countDistinct,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { Account } from "./account.ts";
import { resolveActingAccountForMutation } from "./acting-account.ts";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";
import { ActorSuspendedError, InvalidInputError } from "./error.ts";
import { isPostVisibleToViewer, Post, Question } from "./post.ts";
import { PostVisibility, toPostVisibility } from "./postvisibility.ts";
import { NotAuthenticatedError } from "./session.ts";
import {
  type ActingAccountIdArg,
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "./viewer-actor.ts";

const pollBranchComplexity = { field: 0, multiplier: 0 } as const;
const questionPollComplexity = { field: 0, multiplier: 0 } as const;

// These re-declare a few fields that already exist on the `Post` interface
// so they can carry the lower `questionPollComplexity` cost. Keep
// descriptions in sync with the `Post` interface so consumers browsing
// `Question` directly still see the warnings.
builder.drizzleObjectFields(Question, (t) => ({
  uuid: t.expose("id", {
    type: "UUID",
    complexity: questionPollComplexity,
    description:
      "The post row's primary key, stable for the lifetime of the post. " +
      "Use `Question.sourceId` for source-backed local Questions when " +
      "building public permalinks. Fall back to this row PK for federated " +
      "remote Questions and local share wrappers, whose `sourceId` is `null`.",
  }),
  iri: t.field({
    type: "URL",
    complexity: questionPollComplexity,
    description:
      "The ActivityPub object IRI for this `Question`. Source-backed local " +
      "Questions resolve to the `Question` object route (`/ap/questions/...`), " +
      "not the legacy note route.  When the question is censored or its " +
      "author is hidden by a moderation sanction, and the viewer is neither " +
      "the author nor a moderator, a remote IRI (or a boost wrapper's, whose " +
      "`url` is also nulled) is replaced with the local permalink that " +
      "renders the notice, so a `url ?? iri` fallback never leaks the " +
      "uncensored origin.",
    select: {
      columns: {
        id: true,
        iri: true,
        noteSourceId: true,
        censored: true,
        actorId: true,
        sharedPostId: true,
      },
      with: {
        actor: {
          columns: {
            accountId: true,
            suspended: true,
            suspendedUntil: true,
            handle: true,
          },
        },
        sharedPost: {
          columns: { censored: true, actorId: true },
          with: { actor: sanctionActorSelection },
        },
      },
    },
    resolve: (post, _, ctx) => {
      // A hidden question's own remote IRI (or a boost wrapper's, whose
      // `url` is already nulled) would leak the uncensored origin through
      // the `url ?? iri` fallback; mirror the `url` field and return the
      // local permalink, which renders the notice.  A local non-wrapper
      // question keeps its own `/ap/…` IRI.
      if (
        isPollCensoredForViewer(post, ctx) &&
        post.actor != null &&
        (post.sharedPostId != null || post.actor.accountId == null)
      ) {
        return new URL(
          `/${post.actor.handle}/${post.id}`,
          ctx.fedCtx.canonicalOrigin,
        );
      }
      if (post.noteSourceId != null) {
        return ctx.fedCtx.getObjectUri(vocab.Question, {
          id: post.noteSourceId,
        });
      }
      return new URL(post.iri);
    },
  }),
  visibility: t.field({
    type: PostVisibility,
    complexity: questionPollComplexity,
    description:
      "Who can see this `Question`. Poll votes are accepted only from actors " +
      "who can see the underlying post.",
    select: {
      columns: { visibility: true },
    },
    resolve(post) {
      return toPostVisibility(post.visibility);
    },
  }),
  content: t.field({
    type: "HTML",
    complexity: questionPollComplexity,
    description:
      "The rendered body of the `Question`, excluding poll options. Use " +
      "`Question.poll` to render the voting UI.  Empty when the post is " +
      "censored or its author is hidden by a moderation sanction (or it boosts such a post), and the viewer is neither " +
      "the content's author nor a moderator.",
    select: {
      columns: {
        actorId: true,
        censored: true,
        contentHtml: true,
        emojis: true,
      },
      with: {
        actor: sanctionActorSelection,
        sharedPost: {
          columns: { censored: true, actorId: true },
          with: { actor: sanctionActorSelection },
        },
      },
    },
    resolve: (post, _, ctx) =>
      isPollCensoredForViewer(post, ctx)
        ? ""
        : addExternalLinkTargets(
            renderCustomEmojis(post.contentHtml, post.emojis),
            new URL(ctx.fedCtx.canonicalOrigin),
          ),
  }),
  language: t.exposeString("language", {
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "BCP 47 language tag for `Question.content`, or `null` when the " +
      "source did not provide a language.",
  }),
  url: t.field({
    type: "URL",
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "The canonical, human-readable URL of this question. Source-backed " +
      "local Questions encode `Question.sourceId`; federated remote " +
      "Questions and local share wrappers may not share any path token with " +
      "`Post.uuid`.  `null` when the question is censored or its author is " +
      "hidden by a moderation sanction, and the viewer is neither the " +
      "content's author nor a moderator, EXCEPT for a local question " +
      "(whose own permalink renders the notice): a boost wrapper's URL " +
      "mirrors the boosted post's, and a remote question's URL points at " +
      "the uncensored copy on its origin instance, so both are hidden.",
    select: {
      columns: {
        url: true,
        censored: true,
        actorId: true,
        sharedPostId: true,
      },
      with: {
        actor: sanctionActorSelection,
        sharedPost: {
          columns: { censored: true, actorId: true },
          with: { actor: sanctionActorSelection },
        },
      },
    },
    resolve: (post, _, ctx) => {
      if (post.url == null) return null;
      // When the content is hidden, a boost wrapper's URL mirrors the
      // boosted post's, and a remote question's URL points at the
      // uncensored copy on its origin instance.  Only a local question's
      // own permalink leads to a page that renders the notice, so it is
      // the only URL kept.
      if (
        isPollCensoredForViewer(post, ctx) &&
        (post.sharedPostId != null || post.actor?.accountId == null)
      ) {
        return null;
      }
      return new URL(post.url);
    },
  }),
  published: t.expose("published", {
    type: "DateTime",
    complexity: questionPollComplexity,
    description:
      "When this `Question` was published according to its local source or " +
      "remote ActivityPub object.",
  }),
  actor: t.relation("actor", {
    complexity: questionPollComplexity,
    description: "The actor who authored this `Question`.",
  }),
  quotedPost: t.field({
    type: Post,
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "The post quoted by this `Question`, if any. `null` when the quoting " +
      "`Question` is censored or its author is hidden by a moderation " +
      "sanction and the viewer is neither the author nor a moderator (the " +
      "quoted target is part of the censored content), and also when the " +
      "quoted post is not visible to the viewer (e.g., a followers-only " +
      "post the viewer does not follow), so a public quote cannot leak its " +
      "private target.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    select: (_, __, nestedSelect) => ({
      columns: { actorId: true, censored: true },
      with: { actor: sanctionActorSelection, quotedPost: nestedSelect() },
    }),
    resolve: async (question, args, ctx) => {
      if (isPollCensoredForViewer(question, ctx)) return null;
      const quotedPost = question.quotedPost;
      if (quotedPost == null) return null;
      const viewerActorId = await resolveViewerActorId(
        ctx,
        args as ActingAccountIdArg,
      );
      return (await isPostVisibleToViewer(ctx, quotedPost.id, viewerActorId))
        ? quotedPost
        : null;
    },
  }),
  sharedPost: t.field({
    type: Post,
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "The original post when this row is a local share wrapper. Polls live " +
      "on the original `Question`, not on the wrapper.  `null` when the " +
      "wrapper itself is censored or the booster is hidden by a " +
      "moderation sanction and the viewer is neither the author nor a " +
      "moderator (what was boosted is the hidden content), and also when " +
      "the boosted post is not visible to the viewer (e.g., a " +
      "followers-only post the viewer does not follow).",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    select: (_, __, nestedSelect) => ({
      columns: { actorId: true, censored: true },
      with: { actor: sanctionActorSelection, sharedPost: nestedSelect() },
    }),
    // Row-only check: a wrapper of a censored Question keeps the relation
    // so the boosted Question redacts itself and exposes `censored`.
    resolve: async (question, args, ctx) => {
      if (isPollRowCensoredForViewer(question, ctx)) return null;
      const sharedPost = question.sharedPost;
      if (sharedPost == null) return null;
      const viewerActorId = await resolveViewerActorId(
        ctx,
        args as ActingAccountIdArg,
      );
      return (await isPostVisibleToViewer(ctx, sharedPost.id, viewerActorId))
        ? sharedPost
        : null;
    },
  }),
}));

const Poll = builder.drizzleNode("pollTable", {
  name: "Poll",
  description:
    "A poll attached to a `Question` post. Contains options, vote counts, " +
    "and the voting deadline.  When the owning `Question` is censored " +
    "or its author is hidden by a moderation sanction, the poll " +
    "(including its option titles) is part of the hidden content " +
    "and is only resolvable by the author and moderators, even through " +
    "direct `node(id:)` lookups.",
  authScopes: async (poll, ctx) => {
    const post = await ctx.db.query.postTable.findFirst({
      where: { id: poll.postId },
      columns: { censored: true, actorId: true },
      with: { actor: sanctionActorSelection },
    });
    if (
      post == null ||
      (post.censored == null && !isActorSanctionHidden(post.actor))
    ) {
      return true;
    }
    if (ctx.account?.actor.id === post.actorId) return true;
    return { moderator: true };
  },
  // Run the scope when the node itself is resolved: the Poll node id is
  // the Question's post id, so without this a client could bypass the
  // Question.poll redaction via node(id:).
  runScopesOnType: true,
  id: {
    column: (poll) => poll.postId,
  },
  fields: (t) => ({
    multiple: t.exposeBoolean("multiple", {
      description:
        "Whether voters may select more than one option. When `false`, " +
        "each voter may choose exactly one option.",
    }),
    ends: t.expose("ends", {
      type: "DateTime",
      description:
        "When voting closes. Votes submitted after this time are rejected.",
    }),
    closed: t.boolean({
      description: "Whether the voting period has ended (`ends <= now()`).",
      select: {
        columns: {
          ends: true,
        },
      },
      resolve(poll) {
        return poll.ends <= new Date();
      },
    }),
    viewerHasVoted: t.boolean({
      description:
        "Whether the authenticated viewer has cast at least one vote in " +
        "this poll. Always `false` for unauthenticated requests.",
      select: {
        columns: {
          postId: true,
        },
      },
      async resolve(poll, _, ctx) {
        return (await getViewerPollOptionIndices(ctx, poll.postId)).size > 0;
      },
    }),
    post: t.relation("post", {
      type: Post,
      description: "The `Question` post this poll belongs to.",
    }),
    options: t.field({
      type: [PollOption],
      description: "The poll's voting options, ordered by their display index.",
      complexity: pollBranchComplexity,
      select: (_, __, nestedSelect) => {
        const selection = nestedSelect();
        return {
          with: {
            options: {
              ...(typeof selection === "object" ? selection : {}),
              orderBy: (table, { asc }) => [asc(table.index)],
            },
          },
        };
      },
      resolve(poll) {
        return poll.options.toSorted((a, b) => a.index - b.index);
      },
    }),
    votes: t.connection(
      {
        type: PollVote,
        description:
          "Votes cast across all options, with the total vote count exposed " +
          "on the connection. Votes by actors whose content is hidden by a " +
          "moderation sanction (banned local or federation-blocked remote) " +
          "are excluded from both the edges and `totalCount`, so a hidden " +
          "actor's participation is never revealed.",
        complexity: pollBranchComplexity,
        select: (args, ctx, nestedSelect) => ({
          columns: { postId: true },
          with: {
            // Exclude votes by sanction-hidden actors so the vote list never
            // reveals a banned/federation-blocked actor's participation.
            votes: andActorSanctionFilter(
              pollVoteConnectionHelpers.getQuery(args, ctx, nestedSelect),
              {
                actor: getSanctionVisibleActorFilter((ctx.now ??= new Date())),
              },
            ),
          },
        }),
        async resolve(poll, args, ctx) {
          const connection = pollVoteConnectionHelpers.resolve(
            poll.votes,
            args,
            ctx,
            poll,
          );
          return {
            ...connection,
            totalCount: await pollVisibleVoteCount(ctx, poll.postId),
          };
        },
      },
      {
        fields: (t) => ({
          totalCount: t.exposeInt("totalCount", {
            description:
              "Number of votes across all options, independent of the current " +
              "page size and excluding votes by sanction-hidden actors, so it " +
              "matches the (also sanction-filtered) edges.",
          }),
        }),
      },
    ),
    voters: t.connection(
      {
        type: Actor,
        description:
          "Actors who have voted in this poll (deduplicated across options). " +
          "Actors whose content is hidden by a moderation sanction (banned " +
          "local or federation-blocked remote) are excluded from both the " +
          "edges and `totalCount`.",
        complexity: pollBranchComplexity,
        select: (args, ctx, nestedSelect) => ({
          columns: { postId: true, votersCount: true },
          with: {
            // Exclude sanction-hidden actors from the voter list.
            voters: andActorSanctionFilter(
              actorConnectionHelpers.getQuery(args, ctx, nestedSelect),
              getSanctionVisibleActorFilter((ctx.now ??= new Date())),
            ),
          },
        }),
        async resolve(poll, args, ctx) {
          const connection = actorConnectionHelpers.resolve(
            poll.voters,
            args,
            ctx,
            poll,
          );
          // Stored counter (federated aggregate + local votes) minus the
          // sanction-hidden local voters, so the total matches the filtered
          // edges without zeroing out a remote poll's federated count.
          const hidden = await pollHiddenVoterCount(ctx, poll.postId);
          return {
            ...connection,
            totalCount: Math.max(poll.votersCount - hidden, 0),
          };
        },
      },
      {
        fields: (t) => ({
          totalCount: t.exposeInt("totalCount", {
            description:
              "Number of distinct actors who have voted in this poll, " +
              "independent of the current page size and excluding " +
              "sanction-hidden actors, so it matches the (also " +
              "sanction-filtered) edges.",
          }),
        }),
      },
    ),
  }),
});

const PollOption = builder.drizzleObject("pollOptionTable", {
  name: "PollOption",
  description: "A single choice in a `Poll`.",
  fields: (t) => ({
    index: t.exposeInt("index", {
      description: "Zero-based display order index for this option.",
    }),
    title: t.exposeString("title", {
      description:
        "Human-readable option label exactly as stored for the poll.",
    }),
    poll: t.relation("poll", {
      description: "The poll this option belongs to.",
    }),
    viewerHasVoted: t.boolean({
      description:
        "Whether the authenticated viewer voted for this specific option. " +
        "Always `false` for unauthenticated requests.",
      select: {
        columns: {
          postId: true,
          index: true,
        },
      },
      async resolve(option, _, ctx) {
        return (await getViewerPollOptionIndices(ctx, option.postId)).has(
          option.index,
        );
      },
    }),
    votes: t.connection(
      {
        type: PollVote,
        description:
          "Votes cast for this option. Use `PollOption.viewerHasVoted` for " +
          "the current viewer's selected state. Votes by sanction-hidden " +
          "actors (banned local or federation-blocked remote) are excluded " +
          "from both the edges and `totalCount`.",
        complexity: pollBranchComplexity,
        select: (args, ctx, nestedSelect) => ({
          columns: { postId: true, index: true, votesCount: true },
          with: {
            // Exclude votes by sanction-hidden actors (see `Poll.votes`).
            votes: andActorSanctionFilter(
              pollVoteConnectionHelpers.getQuery(args, ctx, nestedSelect),
              {
                actor: getSanctionVisibleActorFilter((ctx.now ??= new Date())),
              },
            ),
          },
        }),
        async resolve(option, args, ctx) {
          const connection = pollVoteConnectionHelpers.resolve(
            option.votes,
            args,
            ctx,
            option,
          );
          // Stored per-option counter minus the sanction-hidden local votes
          // for this option (keeps remote federated per-option totals intact).
          const hidden = await pollHiddenOptionVoteCount(
            ctx,
            option.postId,
            option.index,
          );
          return {
            ...connection,
            totalCount: Math.max(option.votesCount - hidden, 0),
          };
        },
      },
      {
        fields: (t) => ({
          totalCount: t.exposeInt("totalCount", {
            description:
              "Number of votes for this option, independent of the current " +
              "page size and excluding votes by sanction-hidden actors, so it " +
              "matches the (also sanction-filtered) edges.",
          }),
        }),
      },
    ),
  }),
});

const PollVote = builder.drizzleObject("pollVoteTable", {
  name: "PollVote",
  description:
    "A stored vote by an actor for one option in a `Poll`. Multi-choice " +
    "polls store one `PollVote` per selected option.",
  fields: (t) => ({
    created: t.expose("created", {
      type: "DateTime",
      description: "When this vote was recorded locally.",
    }),
    poll: t.relation("poll", {
      description: "The poll that received this vote.",
    }),
    option: t.relation("option", {
      description: "The selected option for this vote.",
    }),
    actor: t.relation("actor", {
      description: "The actor who cast this vote.",
    }),
  }),
});

const pollVoteConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "pollVoteTable",
  {},
);

const actorConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "actorTable",
  {},
);

// The stored counters (`pollTable.votersCount`, `pollOptionTable.votesCount`)
// include remote-federated aggregates plus one increment per local vote, so a
// visible total is `stored - (sanction-hidden local votes)`; counting only the
// hidden local rows and subtracting keeps remote aggregate totals intact.  The
// poll-level `Poll.votes.totalCount` has no stored counter (it is a live count
// of local rows), so it counts the visible rows directly.  Reconciling these
// totals with their (sanction-filtered) edges is what stops a client inferring
// from `totalCount > edges.length` that a sanction-hidden actor voted.
//
// Each count is batched with a request-scoped `DataLoader` so a list of polls
// (a timeline, a profile) runs one grouped query instead of one per poll or
// option.  Sanction activeness is compared against the request clock
// (`ctx.now`), matching `isActorSanctionHidden` and the edge filters, not SQL
// `now()` (which is frozen inside a transaction).

// Voter is NOT hidden by a sanction (mirror of `getSanctionVisibleActorFilter`
// as a raw predicate over the joined `actorTable`).
function pollVoterNotHiddenCondition(now: Date) {
  return or(
    isNull(actorTable.suspended),
    gt(actorTable.suspended, now),
    lte(actorTable.suspendedUntil, now),
    and(isNotNull(actorTable.accountId), gt(actorTable.suspendedUntil, now)),
  );
}

// Voter IS hidden by a sanction (the complement used to subtract from the
// stored counters).
function pollVoterHiddenCondition(now: Date) {
  return and(
    lte(actorTable.suspended, now),
    or(
      // A `null` `suspendedUntil` (permanent) hides the actor regardless of
      // whether it is local or remote, so the two `accountId` branches for it
      // collapse into one check.
      isNull(actorTable.suspendedUntil),
      // A remote actor with a still-future `suspendedUntil` stays hidden; a
      // local one is only write-restricted, so its content remains visible.
      and(isNull(actorTable.accountId), gt(actorTable.suspendedUntil, now)),
    ),
  );
}

// `Poll.votes.totalCount`: visible (non-sanction-hidden) votes for the poll.
function pollVisibleVoteCount(ctx: UserContext, postId: Uuid): Promise<number> {
  ctx.pollVisibleVoteCountLoader ??= new DataLoader<Uuid, number>(
    async (ids) => {
      const now = (ctx.now ??= new Date());
      const rows = await ctx.db
        .select({ postId: pollVoteTable.postId, c: count() })
        .from(pollVoteTable)
        .innerJoin(actorTable, eq(actorTable.id, pollVoteTable.actorId))
        .where(
          and(
            inArray(pollVoteTable.postId, ids as Uuid[]),
            pollVoterNotHiddenCondition(now),
          ),
        )
        .groupBy(pollVoteTable.postId);
      const byId = new Map(rows.map((row) => [row.postId, Number(row.c)]));
      return (ids as Uuid[]).map((id) => byId.get(id) ?? 0);
    },
  );
  return ctx.pollVisibleVoteCountLoader.load(postId);
}

// `Poll.voters.totalCount`: distinct sanction-hidden voters, subtracted from
// the stored `votersCount`.
function pollHiddenVoterCount(ctx: UserContext, postId: Uuid): Promise<number> {
  ctx.pollHiddenVoterCountLoader ??= new DataLoader<Uuid, number>(
    async (ids) => {
      const now = (ctx.now ??= new Date());
      const rows = await ctx.db
        .select({
          postId: pollVoteTable.postId,
          c: countDistinct(pollVoteTable.actorId),
        })
        .from(pollVoteTable)
        .innerJoin(actorTable, eq(actorTable.id, pollVoteTable.actorId))
        .where(
          and(
            inArray(pollVoteTable.postId, ids as Uuid[]),
            pollVoterHiddenCondition(now),
          ),
        )
        .groupBy(pollVoteTable.postId);
      const byId = new Map(rows.map((row) => [row.postId, Number(row.c)]));
      return (ids as Uuid[]).map((id) => byId.get(id) ?? 0);
    },
  );
  return ctx.pollHiddenVoterCountLoader.load(postId);
}

// `PollOption.votes.totalCount`: sanction-hidden votes for one option,
// subtracted from that option's stored `votesCount`.
function pollHiddenOptionVoteCount(
  ctx: UserContext,
  postId: Uuid,
  optionIndex: number,
): Promise<number> {
  ctx.pollHiddenOptionVoteCountLoader ??= new DataLoader<string, number>(
    async (keys) => {
      const now = (ctx.now ??= new Date());
      const postIds = [
        ...new Set((keys as string[]).map((k) => k.split("\n")[0] as Uuid)),
      ];
      const rows = await ctx.db
        .select({
          postId: pollVoteTable.postId,
          optionIndex: pollVoteTable.optionIndex,
          c: count(),
        })
        .from(pollVoteTable)
        .innerJoin(actorTable, eq(actorTable.id, pollVoteTable.actorId))
        .where(
          and(
            inArray(pollVoteTable.postId, postIds),
            pollVoterHiddenCondition(now),
          ),
        )
        .groupBy(pollVoteTable.postId, pollVoteTable.optionIndex);
      const byKey = new Map(
        rows.map((row) => [`${row.postId}\n${row.optionIndex}`, Number(row.c)]),
      );
      return (keys as string[]).map((k) => byKey.get(k) ?? 0);
    },
  );
  return ctx.pollHiddenOptionVoteCountLoader.load(`${postId}\n${optionIndex}`);
}

// Fold an extra `where` filter into a connection helper's query config
// (AND-merged so the helper's own cursor pagination `where` is preserved).
// Mutates and returns the same object; the helper hands back a fresh config
// per call.  Typed loosely because the two vote/voter connections target
// different tables (`pollVoteTable` vs `actorTable`).
// deno-lint-ignore no-explicit-any
function andActorSanctionFilter<Q>(query: Q, extra: any): Q {
  const q = query as { where?: unknown };
  q.where = q.where == null ? extra : { AND: [q.where, extra] };
  return query;
}

async function getViewerPollOptionIndices(
  ctx: UserContext,
  postId: Uuid,
): Promise<ReadonlySet<number>> {
  if (ctx.account == null) return new Set();

  ctx.pollViewerVotes ??= new Map();
  const cached = ctx.pollViewerVotes.get(postId);
  if (cached != null) return await cached;

  const promise = ctx.db.query.pollVoteTable
    .findMany({
      where: {
        postId,
        actorId: ctx.account.actor.id,
      },
      columns: {
        optionIndex: true,
      },
    })
    .then(
      (votes) =>
        new Set(votes.map((vote) => vote.optionIndex)) as ReadonlySet<number>,
    );
  ctx.pollViewerVotes.set(postId, promise);
  return await promise;
}

/**
 * Whether the Question's poll content must be redacted for the current
 * viewer: it is censored, and the viewer is neither its author nor a
 * moderator (mirrors `isCensoredForViewer` in post.ts).  Share wrappers
 * carry denormalized copies of the boosted Question's content and URL,
 * so a loaded `sharedPost` is checked too, with the exemption following
 * the boosted post's author.
 */
function isPollCensoredForViewer(
  post: {
    censored: Date | null;
    actorId: Uuid;
    actor?: SanctionActorColumns | null;
    sharedPost?: {
      censored: Date | null;
      actorId: Uuid;
      actor?: SanctionActorColumns | null;
    } | null;
  },
  ctx: UserContext,
): boolean {
  return (
    isPollRowCensoredForViewer(post, ctx) ||
    (post.sharedPost != null &&
      isPollRowCensoredForViewer(post.sharedPost, ctx))
  );
}

type SanctionActorColumns = Pick<
  ActorRow,
  "accountId" | "suspended" | "suspendedUntil"
>;

/**
 * The actor columns the redaction helpers need to evaluate the author's
 * sanction state; merged into the field selections that call them
 * (mirrors sanctionActorSelection in post.ts).
 */
const sanctionActorSelection = {
  columns: {
    accountId: true,
    suspended: true,
    suspendedUntil: true,
  },
} as const;

/**
 * Like {@link isPollCensoredForViewer}, but considers only the row itself,
 * ignoring any loaded `sharedPost` (mirrors `isRowCensoredForViewer` in
 * post.ts); for the `sharedPost` relation, which a wrapper of a censored
 * Question keeps so the boosted Question redacts itself.
 */
function isPollRowCensoredForViewer(
  row: {
    censored: Date | null;
    actorId: Uuid;
    actor?: SanctionActorColumns | null;
  },
  ctx: UserContext,
): boolean {
  if (ctx.account?.moderator) return false;
  if (ctx.account?.actor.id === row.actorId) return false;
  if (row.censored != null) return true;
  return row.actor != null && isActorSanctionHidden(row.actor);
}

builder.drizzleObjectField(Question, "poll", (t) =>
  t.field({
    type: Poll,
    nullable: true,
    complexity: questionPollComplexity,
    description:
      "Poll data attached to this `Question`, or `null` for shared wrappers " +
      "and Questions whose remote poll data is unavailable. Authenticated " +
      "viewers may trigger a remote backfill for missing poll data.  Also " +
      "`null` when the Question is censored or its author is hidden by " +
      "a moderation sanction, and the viewer is neither the author nor " +
      "a moderator (check `censored` to distinguish the " +
      "redaction from unavailable poll data).",
    select: (_, __, nestedSelect) => ({
      columns: {
        actorId: true,
        censored: true,
        id: true,
        iri: true,
        sharedPostId: true,
      },
      with: {
        actor: sanctionActorSelection,
        poll: nestedSelect(),
      },
    }),
    async resolve(question, _, ctx) {
      // A censored Question's poll (and its option titles) is part of the
      // censored content.
      if (isPollCensoredForViewer(question, ctx)) return null;
      if (question.poll != null) return question.poll;
      if (question.sharedPostId != null) return null;

      // Guests must not trigger federation lookups: they would let
      // unauthenticated callers spawn outbound fetches and persist remote
      // poll subobjects on demand.
      if (ctx.account == null) return null;

      try {
        const documentLoader = await ctx.fedCtx.getDocumentLoader({
          identifier: ctx.account.id,
        });
        const postObject = await ctx.fedCtx.lookupObject(question.iri, {
          documentLoader,
        });
        if (!(postObject instanceof vocab.Question)) return null;

        await persistPost(ctx.fedCtx, postObject, { documentLoader });
      } catch {
        return null;
      }
      const reloaded = await ctx.db.query.postTable.findFirst({
        where: {
          id: question.id,
          type: "Question",
        },
        with: {
          poll: {
            extras: {
              votesCount: (table) =>
                ctx.db.$count(
                  pollVoteTable,
                  eq(pollVoteTable.postId, table.postId),
                ),
            },
            with: {
              options: {
                orderBy: (table, { asc }) => [asc(table.index)],
                with: {
                  votes: true,
                },
              },
              votes: true,
              voters: true,
            },
          },
        },
      });
      return reloaded?.poll ?? null;
    },
  }),
);

builder.relayMutationField(
  "voteOnPoll",
  {
    description:
      "Vote in a visible poll. Votes are idempotent: once the viewer has " +
      "voted, later calls return the stored selections instead of replacing " +
      "them. Federates the vote when the poll is remote.",
    inputFields: (t) => ({
      questionId: t.globalID({
        for: [Question],
        required: true,
        description:
          "Global id of the `Question` whose poll should receive the vote. " +
          "The viewer must be able to see the question.",
      }),
      optionIndices: t.intList({
        required: true,
        description:
          "Zero-based option indices to select. Single-choice polls require " +
          "exactly one index; multi-choice polls accept one or more unique " +
          "indices.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description:
          "Optional `Account` global id to vote as an organization account. " +
          "Omit this to vote as the signed-in personal account.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const optionIndices = new Set(args.input.optionIndices);
      if (optionIndices.size !== args.input.optionIndices.length) {
        throw new InvalidInputError("optionIndices");
      }
      if (optionIndices.size < 1) {
        throw new InvalidInputError("optionIndices");
      }

      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const question = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          poll: {
            with: {
              options: {
                orderBy: (table, { asc }) => [asc(table.index)],
                with: {
                  votes: true,
                },
              },
              votes: true,
              voters: true,
            },
          },
        },
        where: {
          id: args.input.questionId.id,
          type: "Question",
        },
      });

      if (
        question == null ||
        question.poll == null ||
        !isPostVisibleTo(question, actingAccount.actor) ||
        isPollCensoredForViewer(question, ctx)
      ) {
        throw new InvalidInputError("questionId");
      }

      if (question.poll.ends <= new Date()) {
        throw new InvalidInputError("questionId");
      }

      if (!question.poll.multiple && optionIndices.size !== 1) {
        throw new InvalidInputError("optionIndices");
      }

      const validOptionIndices = new Set(
        question.poll.options.map((option) => option.index),
      );
      if ([...optionIndices].some((index) => !validOptionIndices.has(index))) {
        throw new InvalidInputError("optionIndices");
      }

      const persistedVotes = await vote(
        ctx.fedCtx,
        actingAccount,
        question.poll,
        optionIndices,
      );
      if (persistedVotes.length < 1) {
        throw new InvalidInputError("questionId");
      }

      const updatedPoll = await ctx.db.query.pollTable.findFirst({
        extras: {
          votesCount: (table) =>
            ctx.db.$count(
              pollVoteTable,
              eq(pollVoteTable.postId, table.postId),
            ),
        },
        with: {
          options: {
            orderBy: (table, { asc }) => [asc(table.index)],
            with: {
              votes: true,
            },
          },
          votes: true,
          voters: true,
        },
        where: {
          postId: question.id,
        },
      });
      if (updatedPoll == null) {
        throw new InvalidInputError("questionId");
      }

      const votes = persistedVotes
        .toSorted((a, b) => a.optionIndex - b.optionIndex)
        .map((pollVote) => {
          const option = updatedPoll.options.find(
            (option) => option.index === pollVote.optionIndex,
          );
          if (option == null) {
            throw new InvalidInputError("optionIndices");
          }
          return { ...pollVote, option };
        });

      const updatedQuestion = { ...question, poll: updatedPoll };

      return { question: updatedQuestion, poll: updatedPoll, votes };
    },
  },
  {
    outputFields: (t) => ({
      question: t.field({
        type: Question,
        description:
          "The voted `Question`, with poll state reflecting the viewer's " +
          "new selection.",
        resolve(result) {
          return result.question;
        },
      }),
      poll: t.field({
        type: Poll,
        description:
          "The updated poll after replacing the viewer's previous votes.",
        resolve(result) {
          return result.poll;
        },
      }),
      votes: t.field({
        type: [PollVote],
        description:
          "Vote rows created for this request, ordered by option index.",
        resolve(result) {
          return result.votes;
        },
      }),
    }),
  },
);

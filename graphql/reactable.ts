import type { RelationsFilter } from "@hackerspub/models/db";
import { getSanctionVisibleActorFilter } from "@hackerspub/models/post/visibility";
import { getViewerReactionsForPosts } from "@hackerspub/models/reaction";
import { relations } from "@hackerspub/models/relations";
import { actorTable, reactionTable } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import DataLoader from "dataloader";
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { Actor } from "./actor.ts";
import { builder, Node, type UserContext } from "./builder.ts";
import {
  type ActingAccountIdArg,
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "./viewer-actor.ts";

export interface Reactable {
  id: Uuid;
  reactionsCounts: Record<string, number>;
}

interface ViewerHasReactedKey {
  postId: Uuid;
  emoji: string | null;
  customEmojiId: Uuid | null;
  viewerActorId: Uuid | null;
}

// Encoded as JSON because federated reaction emoji can contain any
// character; a delimiter-based encoding could collide.
function encodeReactionKey(connection: {
  postId: Uuid;
  where: RelationsFilter<"reactionTable">;
}, viewerActorId: Uuid | null): string {
  const filter = connection.where as {
    emoji?: string;
    customEmojiId?: Uuid;
  };
  const key: ViewerHasReactedKey = {
    postId: connection.postId,
    emoji: filter.emoji ?? null,
    customEmojiId: filter.customEmojiId ?? null,
    viewerActorId,
  };
  return JSON.stringify(key);
}

function decodeReactionKey(key: string): ViewerHasReactedKey {
  return JSON.parse(key) as ViewerHasReactedKey;
}

export const Reactable = builder.interfaceRef<Reactable>("Reactable");

Reactable.implement({
  description:
    "An object that can receive emoji reactions. Implemented by `Post` " +
    "types (`Note`, `Article`, `Question`).",
  interfaces: [Node],
  fields: (t) => ({
    reactionGroups: t.field({
      type: [ReactionGroup],
      async resolve(post, _args, ctx) {
        const groups = Object.entries(post.reactionsCounts)
          .map(
            (
              [emojiOrId, count],
            ): EmojiReactionGroup | CustomEmojiReactionGroup => {
              return {
                subject: post,
                count,
                ...(validateUuid(emojiOrId)
                  ? {
                    type: "CustomEmoji",
                    customEmojiId: emojiOrId,
                    where: { customEmojiId: emojiOrId },
                  }
                  : {
                    type: "Emoji",
                    emoji: emojiOrId,
                    where: { emoji: emojiOrId },
                  }),
              };
            },
          );
        // Drop groups whose reactors are all hidden by a sanction: the
        // denormalized `reactionsCounts` still lists such an emoji, but
        // surfacing the group would disclose that a hidden actor reacted with
        // it.  Uses the same batched, request-shared count as
        // `reactors.totalCount`, so it adds no query beyond that.
        const visibleCounts = await Promise.all(
          groups.map((group) =>
            reactorCount(
              ctx,
              post.id,
              group.where as { emoji?: string; customEmojiId?: Uuid },
            )
          ),
        );
        return groups.filter((_group, i) => visibleCounts[i] > 0);
      },
    }),
    // Singular accessor for one reaction group on the post, used by the
    // engagement-detail pages to paginate the reactors connection for a
    // specific emoji without re-fetching every group on every page.
    // Returns null when neither key is given, both keys are given, or
    // the post has no recorded reactions for the requested key.
    reactionGroup: t.field({
      type: ReactionGroup,
      nullable: true,
      args: {
        emoji: t.arg.string({ required: false }),
        customEmojiId: t.arg.globalID({ for: CustomEmoji, required: false }),
      },
      async resolve(post, args, ctx) {
        const emoji = args.emoji ?? null;
        const customEmojiId = args.customEmojiId?.id ?? null;
        if (
          (emoji == null && customEmojiId == null) ||
          (emoji != null && customEmojiId != null)
        ) {
          return null;
        }
        if (customEmojiId != null) {
          const count = post.reactionsCounts[customEmojiId];
          if (count == null) return null;
          // Hide the group when every reactor is sanction-hidden (see
          // `reactionGroups`), so a direct query for one emoji cannot confirm
          // a hidden actor reacted with it.
          if (
            await reactorCount(ctx, post.id, {
              customEmojiId: customEmojiId as Uuid,
            }) < 1
          ) {
            return null;
          }
          return {
            subject: post,
            count,
            type: "CustomEmoji",
            customEmojiId: customEmojiId as Uuid,
            where: { customEmojiId: customEmojiId as Uuid },
          } satisfies CustomEmojiReactionGroup;
        }
        const count = post.reactionsCounts[emoji!];
        if (count == null) return null;
        if (await reactorCount(ctx, post.id, { emoji: emoji! }) < 1) {
          return null;
        }
        return {
          subject: post,
          count,
          type: "Emoji",
          emoji: emoji!,
          where: { emoji: emoji! },
        } satisfies EmojiReactionGroup;
      },
    }),
  }),
});

export interface ReactionGroup {
  type: "Emoji" | "CustomEmoji";
  subject: Reactable;
  count: number;
  where: RelationsFilter<"reactionTable">;
}

export const ReactionGroup = builder.interfaceRef<ReactionGroup>(
  "ReactionGroup",
).implement({
  resolveType(group) {
    switch (group.type) {
      case "Emoji":
        return EmojiReactionGroup.name;
      case "CustomEmoji":
        return CustomEmojiReactionGroup.name;
      default:
        assertNever(group.type, `Unknown reaction group type: ${group.type}`);
    }
  },
  fields: (t) => ({
    subject: t.field({ type: Reactable, resolve: (group) => group.subject }),
    reactors: t.connection({
      type: Actor,
      async resolve(group, args, ctx, info) {
        const query = reactorConnectionHelpers.getQuery(args, ctx, info);
        // Evaluate sanction activeness for both the edges and the total
        // against the same instant (the request clock), so they cannot
        // disagree at a suspension boundary.
        const now = (ctx.now ??= new Date());
        // Exclude reactions by actors whose content is hidden by a
        // moderation sanction (banned local / federation-blocked remote), so
        // the reactor list never reveals a sanction-hidden actor's identity
        // or participation.
        const where = query.where == null
          ? {
            AND: [
              group.where,
              { postId: group.subject.id },
              { actor: getSanctionVisibleActorFilter(now) },
            ],
          }
          : {
            AND: [
              query.where,
              group.where,
              { postId: group.subject.id },
              { actor: getSanctionVisibleActorFilter(now) },
            ],
          };
        const reactions = await ctx.db.query.reactionTable.findMany({
          ...query,
          where,
        });
        return {
          postId: group.subject.id,
          where: group.where,
          ...reactorConnectionHelpers.resolve(reactions, args, ctx),
          // The denormalized reaction counter still includes sanction-hidden
          // reactors, so recompute the total (batched across the request) to
          // keep it consistent with the sanction-filtered edges and avoid
          // revealing that a hidden actor reacted.
          totalCount: await reactorCount(
            ctx,
            group.subject.id,
            group.where as { emoji?: string; customEmojiId?: Uuid },
          ),
        };
      },
    }, {
      extensions: {
        pothosDrizzleTable: relations.reactionTable,
      },
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
        viewerHasReacted: t.loadable({
          type: "Boolean",
          description:
            "Whether the selected viewer account reacted with this reaction " +
            "group's emoji. Always `false` for unauthenticated requests. Pass " +
            "`actingAccountId` for an organization perspective.",
          args: {
            actingAccountId: t.arg.globalID({
              required: false,
              description: actingAccountIdArgDescription,
            }),
          },
          loaderOptions: { cache: false },
          load: async (
            keys: string[],
            ctx: UserContext,
          ): Promise<boolean[]> => {
            const decoded = keys.map(decodeReactionKey);
            const rowsByViewer = new Map<
              Uuid,
              Awaited<
                ReturnType<typeof getViewerReactionsForPosts>
              >
            >();
            const postIdsByViewer = new Map<Uuid, Set<Uuid>>();
            for (const key of decoded) {
              if (key.viewerActorId == null) continue;
              let postIds = postIdsByViewer.get(key.viewerActorId);
              if (postIds == null) {
                postIds = new Set();
                postIdsByViewer.set(key.viewerActorId, postIds);
              }
              postIds.add(key.postId);
            }
            for (const [viewerActorId, postIds] of postIdsByViewer) {
              rowsByViewer.set(
                viewerActorId,
                await getViewerReactionsForPosts(
                  ctx.db,
                  [...postIds],
                  { id: viewerActorId },
                ),
              );
            }
            return decoded.map((key) =>
              key.viewerActorId != null &&
              (rowsByViewer.get(key.viewerActorId) ?? []).some((row) =>
                row.postId === key.postId &&
                (key.emoji == null || row.emoji === key.emoji) &&
                (key.customEmojiId == null ||
                  row.customEmojiId === key.customEmojiId)
              )
            );
          },
          resolve: async (connection, args: ActingAccountIdArg, ctx) =>
            encodeReactionKey(
              connection,
              await resolveViewerActorId(ctx, args),
            ),
        }),
      }),
    }),
  }),
});

const reactorConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "reactionTable",
  {
    select: (nodeSelection) => ({
      with: {
        actor: nodeSelection(),
      },
    }),
    resolveNode: (reaction) => reaction.actor,
  },
);

// Batches `ReactionGroup.reactors.totalCount` across every group in the
// request, so a list of posts resolves the counts in one query instead of one
// per reaction group.  Keyed by (postId, customEmojiId | emoji); the
// sanction-visible actor predicate uses the request clock (`ctx.now`) so the
// count is evaluated against the same instant as the edge query.  The count is
// recomputed (rather than read from the denormalized counter) because that
// counter still includes sanction-hidden reactors.
function reactorKey(
  postId: Uuid,
  filter: { emoji?: string | null; customEmojiId?: Uuid | null },
): string {
  return filter.customEmojiId != null
    ? `c\n${postId}\n${filter.customEmojiId}`
    : `e\n${postId}\n${filter.emoji ?? ""}`;
}

function reactorCount(
  ctx: UserContext,
  postId: Uuid,
  groupFilter: { emoji?: string; customEmojiId?: Uuid },
): Promise<number> {
  ctx.reactorCountLoader ??= new DataLoader<string, number>(async (keys) => {
    const now = (ctx.now ??= new Date());
    const postIds = [
      ...new Set((keys as string[]).map((k) => k.split("\n")[1] as Uuid)),
    ];
    const rows = await ctx.db
      .select({
        postId: reactionTable.postId,
        emoji: reactionTable.emoji,
        customEmojiId: reactionTable.customEmojiId,
        c: count(),
      })
      .from(reactionTable)
      .innerJoin(actorTable, eq(actorTable.id, reactionTable.actorId))
      .where(
        and(
          inArray(reactionTable.postId, postIds),
          or(
            isNull(actorTable.suspended),
            gt(actorTable.suspended, now),
            lte(actorTable.suspendedUntil, now),
            and(
              isNotNull(actorTable.accountId),
              gt(actorTable.suspendedUntil, now),
            ),
          ),
        ),
      )
      .groupBy(
        reactionTable.postId,
        reactionTable.emoji,
        reactionTable.customEmojiId,
      );
    const byKey = new Map<string, number>();
    for (const row of rows) {
      byKey.set(reactorKey(row.postId, row), Number(row.c));
    }
    return (keys as string[]).map((k) => byKey.get(k) ?? 0);
  });
  return ctx.reactorCountLoader.load(reactorKey(postId, groupFilter));
}

export interface EmojiReactionGroup extends ReactionGroup {
  type: "Emoji";
  emoji: string;
}

const EmojiReactionGroup = builder.objectRef<EmojiReactionGroup>(
  "EmojiReactionGroup",
);

EmojiReactionGroup.implement({
  interfaces: [ReactionGroup],
  fields: (t) => ({
    emoji: t.exposeString("emoji", { nullable: false as never }),
  }),
});

export interface CustomEmojiReactionGroup extends ReactionGroup {
  type: "CustomEmoji";
  customEmojiId: Uuid;
}

export const CustomEmoji = builder.drizzleNode("customEmojiTable", {
  name: "CustomEmoji",
  id: {
    column: (emoji) => emoji.id,
  },
  fields: (t) => ({
    iri: t.field({
      type: "URL",
      resolve: (emoji) => new URL(emoji.iri),
    }),
    name: t.exposeString("name"),
    imageUrl: t.exposeString("imageUrl"),
  }),
});

const CustomEmojiReactionGroup = builder.objectRef<CustomEmojiReactionGroup>(
  "CustomEmojiReactionGroup",
);

CustomEmojiReactionGroup.implement({
  interfaces: [ReactionGroup],
  fields: (t) => ({
    customEmoji: t.loadable({
      type: CustomEmoji,
      load: async (ids: Uuid[], ctx: UserContext) => {
        const rows = await ctx.db.query.customEmojiTable.findMany({
          where: { id: { in: ids } },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return ids.map((id) => {
          const row = byId.get(id);
          if (row == null) {
            return new Error(`Custom emoji not found: ${id}`);
          }
          return row;
        });
      },
      resolve: (group) => group.customEmojiId,
    }),
  }),
});

export interface StandardEmoji {
  raw: string;
}

export const StandardEmoji = builder.objectRef<StandardEmoji>("StandardEmoji");

StandardEmoji.implement({
  fields: (t) => ({
    raw: t.exposeString("raw"),
  }),
});

export const ReactionData = builder.unionType("ReactionData", {
  types: [StandardEmoji, CustomEmoji] as const,
  resolveType(value) {
    if (value && typeof value === "object" && "raw" in value) {
      return StandardEmoji;
    }
    return CustomEmoji;
  },
});

export const Reaction = builder.drizzleNode("reactionTable", {
  name: "Reaction",
  id: {
    column: (reaction) => reaction.iri,
  },
  fields: (t) => ({
    data: t.field({
      type: ReactionData,
      tracing: true,
      select: () => {
        return {
          columns: {
            emoji: true,
          },
          with: {
            customEmoji: true,
          },
        };
      },
      resolve: (reaction) => {
        if (reaction.emoji) {
          return { raw: reaction.emoji };
        } else if (reaction.customEmoji) {
          return reaction.customEmoji;
        } else {
          throw createGraphQLError(
            "Reaction has neither emoji nor customEmojiId.",
            {
              originalError: new Error(
                "Reaction has neither emoji nor customEmojiId.",
              ),
              extensions: { code: "INTERNAL_SERVER_ERROR" },
            },
          );
        }
      },
    }),
    actor: t.relation("actor"),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

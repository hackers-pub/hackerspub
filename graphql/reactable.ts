import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import type { RelationsFilter } from "@hackerspub/models/db";
import { getViewerReactionsForPosts } from "@hackerspub/models/reaction";
import { relations } from "@hackerspub/models/relations";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
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
      resolve(post) {
        return Object.entries(post.reactionsCounts)
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
      resolve(post, args) {
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
        const where = query.where == null
          ? {
            ...group.where,
            postId: group.subject.id,
          }
          : {
            AND: [
              query.where,
              group.where,
              { postId: group.subject.id },
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
          totalCount: group.count,
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

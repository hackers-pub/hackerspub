import type { RelationsFilter } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import { Actor } from "./actor.ts";
import { builder, Node } from "./builder.ts";

export interface Reactable {
  id: Uuid;
  reactionsCounts: Record<string, number>;
}

export const Reactable = builder.interfaceRef<Reactable>("Reactable");

Reactable.implement({
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
        const reactions = query.where == null
          ? []
          : await ctx.db.query.reactionTable.findMany({
            ...query,
            where: {
              ...query.where,
              ...group.where,
              postId: group.subject.id,
            },
          });
        return {
          totalCount: group.count,
          postId: group.subject.id,
          where: group.where,
          ...reactorConnectionHelpers.resolve(reactions, args, ctx),
        };
      },
    }, {
      extensions: {
        pothosDrizzleTable: relations.tablesConfig.reactionTable,
      },
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
        viewerHasReacted: t.boolean({
          async resolve(connection, _, ctx) {
            if (ctx.account == null) return false;

            // Build the where condition based on connection.where filter
            const whereCondition = {
              actorId: ctx.account.actor.id,
              postId: connection.postId,
              ...connection.where,
            };

            const reaction = await ctx.db.query.reactionTable.findFirst({
              where: whereCondition,
            });

            return !!reaction;
          },
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

const CustomEmojiReactionGroup = builder.objectRef<CustomEmojiReactionGroup>(
  "CustomEmojiReactionGroup",
);

CustomEmojiReactionGroup.implement({
  interfaces: [ReactionGroup],
  fields: (t) => ({
    customEmoji: t.drizzleField({
      type: "customEmojiTable",
      async resolve(query, group, _, ctx) {
        const customEmoji = await ctx.db.query.customEmojiTable.findFirst(
          query({ where: { id: group.customEmojiId } }),
        );
        if (!customEmoji) throw new Error(`Custom emoji not found`);
        return customEmoji;
      },
    }),
  }),
});

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
          throw new Error("Reaction has neither emoji nor customEmojiId");
        }
      },
    }),
    actor: t.relation("actor"),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

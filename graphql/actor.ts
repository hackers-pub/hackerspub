import { isActor } from "@fedify/vocab";
import { desc, eq } from "drizzle-orm";
import { getAvatarUrl, persistActor } from "@hackerspub/models/actor";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import type { Actor as ActorModel } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import { escape } from "@std/html/entities";
import xss from "xss";
import { builder } from "./builder.ts";
import { Article, Note, Post, Question } from "./post.ts";

export const ActorType = builder.enumType("ActorType", {
  values: [
    "APPLICATION",
    "GROUP",
    "ORGANIZATION",
    "PERSON",
    "SERVICE",
  ] as const,
});

export const Actor = builder.drizzleNode("actorTable", {
  name: "Actor",
  id: {
    column: (actor) => actor.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.field({
      type: "URL",
      select: {
        columns: { iri: true, accountId: true },
      },
      resolve(actor, _, ctx) {
        return actor.accountId == null
          ? new URL(actor.iri)
          : ctx.fedCtx.getActorUri(actor.accountId);
      },
    }),
    type: t.field({
      type: ActorType,
      select: {
        columns: { type: true },
      },
      resolve(actor) {
        return actor.type === "Application"
          ? "APPLICATION"
          : actor.type === "Group"
          ? "GROUP"
          : actor.type === "Organization"
          ? "ORGANIZATION"
          : actor.type === "Person"
          ? "PERSON"
          : actor.type === "Service"
          ? "SERVICE"
          : assertNever(
            actor.type,
            `Unknown value in \`Actor.type\`: "${actor.type}"`,
          );
      },
    }),
    local: t.boolean({
      select: {
        columns: { accountId: true },
      },
      resolve(actor) {
        return actor.accountId != null;
      },
    }),
    username: t.exposeString("username"),
    instanceHost: t.exposeString("instanceHost"),
    handleHost: t.exposeString("handleHost"),
    handle: t.exposeString("handle"),
    rawName: t.exposeString("name", { nullable: true }),
    name: t.field({
      type: "HTML",
      nullable: true,
      select: {
        columns: { name: true, emojis: true },
      },
      resolve(actor) {
        return actor.name
          ? renderCustomEmojis(escape(actor.name), actor.emojis)
          : null;
      },
    }),
    bio: t.field({
      type: "HTML",
      nullable: true,
      resolve(actor) {
        return actor.bioHtml
          ? renderCustomEmojis(actor.bioHtml, actor.emojis)
          : null;
      },
    }),
    automaticallyApprovesFollowers: t.exposeBoolean(
      "automaticallyApprovesFollowers",
    ),
    avatarUrl: t.field({
      type: "URL",
      resolve(actor) {
        const url = getAvatarUrl(actor);
        return new URL(url);
      },
    }),
    avatarInitials: t.field({
      type: "String",
      resolve(actor) {
        const name = actor.name ?? actor.username;
        const parts = name.trim().split(/[\s_-]+/);
        if (parts.length === 0) return "?";
        if (parts.length === 1) {
          return parts[0].substring(0, 2).toUpperCase();
        }
        return (
          parts[0][0] + parts[parts.length - 1][0]
        ).toUpperCase();
      },
    }),
    headerUrl: t.field({
      type: "URL",
      nullable: true,
      resolve(actor) {
        return actor.headerUrl ? new URL(actor.headerUrl) : null;
      },
    }),
    sensitive: t.exposeBoolean("sensitive"),
    url: t.field({
      type: "URL",
      nullable: true,
      resolve(actor) {
        return actor.url ? new URL(actor.url) : null;
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime", nullable: true }),
    created: t.expose("created", { type: "DateTime" }),
    account: t.relation("account", { nullable: true }),
    instance: t.relation("instance", { type: Instance, nullable: true }),
    successor: t.relation("successor", { nullable: true }),
    fields: t.field({
      type: [ActorFieldRef],
      resolve(actor) {
        const fields: ActorField[] = [];
        for (const field in actor.fieldHtmls) {
          const value = actor.fieldHtmls[field];
          fields.push({ name: field, value: xss(value) });
        }
        return fields;
      },
    }),
    posts: t.relatedConnection("posts", {
      type: Post,
      query: (_, ctx) => ({
        where: getPostVisibilityFilter(ctx.account?.actor ?? null),
        orderBy: { published: "desc" },
      }),
    }),
    notes: t.relatedConnection("posts", {
      type: Note,
      query: (_, ctx) => ({
        where: {
          AND: [
            { type: "Note" },
            getPostVisibilityFilter(ctx.account?.actor ?? null),
          ],
        },
        orderBy: { published: "desc" },
      }),
    }),
    noteByUuid: t.drizzleField({
      type: Note,
      select: { columns: { id: true } },
      nullable: true,
      args: {
        uuid: t.arg({ type: "UUID", required: true }),
      },
      async resolve(query, actor, args, ctx) {
        if (!validateUuid(args.uuid)) return null;

        const visibility = getPostVisibilityFilter(ctx.account?.actor ?? null);
        const note = await ctx.db.query.postTable.findFirst(query({
          where: {
            AND: [
              { type: "Note", actorId: actor.id },
              {
                OR: [
                  { id: args.uuid },
                  { noteSourceId: args.uuid },
                ],
              },
              visibility,
            ],
          },
        }));
        return note || null;
      },
    }),
    articles: t.relatedConnection("posts", {
      type: Article,
      query: (_, ctx) => ({
        where: {
          AND: [
            { type: "Article" },
            {
              articleSourceId: {
                isNotNull: true,
              },
            },
            getPostVisibilityFilter(ctx.account?.actor ?? null),
          ],
        },
        orderBy: { published: "desc" },
      }),
    }),
    questions: t.relatedConnection("posts", {
      type: Question,
      query: (_, ctx) => ({
        where: {
          AND: [
            { type: "Question" },
            getPostVisibilityFilter(ctx.account?.actor ?? null),
          ],
        },
        orderBy: { published: "desc" },
      }),
    }),
    sharedPosts: t.relatedConnection("posts", {
      type: Post,
      query: (_, ctx) => ({
        where: {
          AND: [
            getPostVisibilityFilter(ctx.account?.actor ?? null),
            { sharedPostId: { isNotNull: true } },
          ],
        },
        orderBy: { published: "desc" },
      }),
    }),
    pins: t.connection({
      type: Post,
      select: (args, ctx, nestedSelection) => ({
        with: {
          pins: pinConnectionHelpers.getQuery(args, ctx, nestedSelection),
        },
      }),
      resolve: (actor, args, ctx) =>
        pinConnectionHelpers.resolve(actor.pins, args, ctx),
    }),
  }),
});

builder.drizzleObjectFields(Actor, (t) => ({
  followers: t.connection(
    {
      type: Actor,
      select: (args, ctx, select) => ({
        columns: { followersCount: true },
        with: {
          followers: followerConnectionHelpers.getQuery(args, ctx, select),
        },
      }),
      resolve: (actor, args, ctx) => ({
        ...followerConnectionHelpers.resolve(actor.followers, args, ctx),
        totalCount: actor.followersCount,
      }),
    },
    {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    },
    {
      fields: (t) => ({
        iri: t.field({
          type: "URL",
          resolve: (edge) => new URL(edge.iri),
        }),
        accepted: t.expose("accepted", { type: "DateTime", nullable: true }),
        created: t.expose("created", { type: "DateTime" }),
      }),
    },
  ),
  follows: t.field({
    type: "Boolean",
    args: {
      followeeId: t.arg.globalID(),
    },
    async resolve(actor, { followeeId }, ctx) {
      if (
        followeeId == null || followeeId.typename !== "Actor" ||
        !validateUuid(followeeId.id)
      ) {
        return false;
      }
      return await ctx.db.query.followingTable.findFirst({
        columns: { iri: true },
        where: {
          followerId: actor.id,
          followeeId: followeeId.id,
        },
      }) != null;
    },
  }),
  followsViewer: t.field({
    type: "Boolean",
    async resolve(actor, _, ctx) {
      if (ctx.account == null || ctx.account.actor == null) {
        return false;
      }
      return await ctx.db.query.followingTable.findFirst({
        columns: { iri: true },
        where: {
          followerId: actor.id,
          followeeId: ctx.account.actor.id,
        },
      }) != null;
    },
  }),
  followees: t.connection(
    {
      type: Actor,
      select: (args, ctx, select) => ({
        columns: { followeesCount: true },
        with: {
          followees: followeeConnectionHelpers.getQuery(args, ctx, select),
        },
      }),
      resolve: (actor, args, ctx) => ({
        ...followeeConnectionHelpers.resolve(actor.followees, args, ctx),
        totalCount: actor.followeesCount,
      }),
    },
    {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    },
    {
      fields: (t) => ({
        iri: t.field({
          type: "URL",
          resolve: (edge) => new URL(edge.iri),
        }),
        accepted: t.expose("accepted", { type: "DateTime", nullable: true }),
        created: t.expose("created", { type: "DateTime" }),
      }),
    },
  ),
  isFollowedBy: t.field({
    type: "Boolean",
    args: {
      followerId: t.arg.globalID(),
    },
    async resolve(actor, { followerId }, ctx) {
      if (
        followerId == null || followerId.typename !== "Actor" ||
        !validateUuid(followerId.id)
      ) {
        return false;
      }
      return await ctx.db.query.followingTable.findFirst({
        columns: { iri: true },
        where: {
          followerId: followerId.id,
          followeeId: actor.id,
        },
      }) != null;
    },
  }),
}));

interface ActorField {
  name: string;
  value: string;
}

const ActorFieldRef = builder.objectRef<ActorField>("ActorField");

ActorFieldRef.implement({
  description: "A property pair in an actor's account.",
  fields: (t) => ({
    name: t.exposeString("name"),
    value: t.expose("value", { type: "HTML" }),
  }),
});

const followerConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "followingTable",
  {
    select: (nodeSelection) => ({
      with: {
        follower: nodeSelection({}),
      },
    }),
    resolveNode: (following) => following.follower,
  },
);

const followeeConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "followingTable",
  {
    select: (nodeSelection) => ({
      with: {
        followee: nodeSelection({}),
      },
    }),
    resolveNode: (following) => following.followee,
  },
);

const pinConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "pinTable",
  {
    select: (nodeSelection) => ({
      with: {
        post: nodeSelection({}),
      },
    }),
    resolveNode: (pin) => pin.post,
  },
);

export const Instance = builder.drizzleNode("instanceTable", {
  name: "Instance",
  id: {
    column: (instance) => instance.host,
  },
  fields: (t) => ({
    host: t.exposeString("host"),
    software: t.exposeString("software", { nullable: true }),
    softwareVersion: t.exposeString("softwareVersion", {
      nullable: true,
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

builder.queryFields((t) => ({
  actorByUuid: t.drizzleField({
    type: Actor,
    args: {
      uuid: t.arg({
        type: "UUID",
        required: true,
      }),
    },
    nullable: true,
    resolve(query, _, { uuid }, ctx) {
      return ctx.db.query.actorTable.findFirst(
        query({ where: { id: uuid } }),
      );
    },
  }),
  actorByHandle: t.drizzleField({
    type: Actor,
    args: {
      handle: t.arg.string({ required: true }),
      allowLocalHandle: t.arg.boolean({
        defaultValue: false,
        description: "Whether to allow local handles (e.g. @username).",
      }),
    },
    nullable: true,
    async resolve(query, _, { handle, allowLocalHandle }, ctx) {
      if (handle.startsWith("@")) handle = handle.substring(1);
      const split = handle.split("@");
      let actor: ActorModel | undefined = undefined;
      if (split.length === 2) {
        const [username, host] = split;
        actor = await ctx.db.query.actorTable.findFirst(
          query({
            where: {
              username,
              OR: [{ instanceHost: host }, { handleHost: host }],
            },
          }),
        );
      } else if (split.length === 1 && allowLocalHandle) {
        actor = await ctx.db.query.actorTable.findFirst(
          query({
            where: { username: split[0], accountId: { isNotNull: true } },
          }),
        );
      }
      if (actor) return actor;
      const documentLoader = ctx.account == null
        ? ctx.fedCtx.documentLoader
        : await ctx.fedCtx.getDocumentLoader({ identifier: ctx.account.id });
      const actorObject = await ctx.fedCtx.lookupObject(
        handle,
        { documentLoader },
      );
      if (!isActor(actorObject)) return null;
      return await persistActor(ctx.fedCtx, actorObject, { documentLoader });
    },
  }),
  instanceByHost: t.drizzleField({
    type: Instance,
    args: {
      host: t.arg.string({ required: true }),
    },
    nullable: true,
    resolve(query, _, { host }, ctx) {
      return ctx.db.query.instanceTable.findFirst(
        query({ where: { host } }),
      );
    },
  }),
  searchActorsByHandle: t.drizzleField({
    type: [Actor],
    authScopes: { signed: true },
    args: {
      prefix: t.arg.string({ required: true }),
      limit: t.arg.int({ defaultValue: 25 }),
    },
    async resolve(query, _, args, ctx) {
      const cleanPrefix = args.prefix.replace(/^\s*@|\s+$/g, "");
      if (!cleanPrefix) return [];

      const [username, host] = cleanPrefix.includes("@")
        ? cleanPrefix.split("@")
        : [cleanPrefix, undefined];

      const canonicalHost = new URL(ctx.fedCtx.canonicalOrigin).host;

      const whereClause = host == null || !URL.canParse(`http://${host}`)
        ? { username: { ilike: `${username.replace(/([%_])/g, "\\$1")}%` } }
        : {
          username,
          handleHost: {
            ilike: `${
              new URL(`http://${host}`).host.replace(/([%_])/g, "\\$1")
            }%`,
          },
        };

      return ctx.db.query.actorTable.findMany(
        query({
          where: {
            ...whereClause,
            NOT: { username: canonicalHost, handleHost: canonicalHost },
          },
          orderBy: (t) => [
            desc(eq(t.username, username)),
            desc(eq(t.handleHost, canonicalHost)),
            t.username,
            t.handleHost,
          ],
          limit: Math.min(args.limit ?? 25, 50),
        }),
      );
    },
  }),
}));

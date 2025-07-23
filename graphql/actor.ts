import { isActor } from "@fedify/fedify";
import { getAvatarUrl, persistActor } from "@hackerspub/models/actor";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import { escape } from "@std/html/entities";
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
      resolve(actor) {
        return new URL(actor.iri);
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
    articles: t.relatedConnection("posts", {
      type: Article,
      query: (_, ctx) => ({
        where: {
          AND: [
            { type: "Article" },
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
  followees: t.connection(
    {
      type: Actor,
      select: (args, ctx, select) => ({
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
}));

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
    },
    nullable: true,
    async resolve(query, _, { handle }, ctx) {
      if (handle.startsWith("@")) handle = handle.substring(1);
      const split = handle.split("@");
      if (split.length !== 2) return null;
      const [username, host] = split;
      const actor = await ctx.db.query.actorTable.findFirst(
        query({
          where: {
            username,
            OR: [{ instanceHost: host }, { handleHost: host }],
          },
        }),
      );
      if (actor) return actor;
      // FIXME: documentLoader
      const documentLoader = ctx.fedCtx.documentLoader;
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
}));

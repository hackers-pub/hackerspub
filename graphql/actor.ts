import { assert } from "@std/assert";
import { isActor } from "@fedify/vocab";
import DataLoader from "dataloader";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getAvatarUrl,
  persistActor,
  recommendActors,
} from "@hackerspub/models/actor";
import {
  block,
  getBlockedActorIds,
  getBlockerActorIds,
  unblock,
} from "@hackerspub/models/blocking";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import {
  follow,
  getFollowedActorIds,
  getFollowerActorIds,
  removeFollower as removeFollowerModel,
  unfollow,
} from "@hackerspub/models/following";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import { type Actor as ActorRow, actorTable } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { assertNever } from "@std/assert/unstable-never";
import { escape } from "@std/html/entities";
import xss from "xss";
import { builder, type UserContext } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { lookupActorByUrl, parseHttpUrl } from "./lookup.ts";
import { Article, Note, Post, Question } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

// Per-request loader keyed by actor id.  Several resolvers (e.g.,
// `Notification.actors`) need to fetch actor rows by id one-by-one
// while iterating a list; without batching, that fans out to one
// `SELECT` per actor.  This helper collapses every actor id requested
// across the active GraphQL execution into a single
// `SELECT … WHERE id = ANY($1)` and dedupes overlapping ids via
// DataLoader's per-request cache.
export function getActorById(
  ctx: UserContext,
  actorId: Uuid,
): Promise<ActorRow | null> {
  ctx.actorByIdLoader ??= new DataLoader<Uuid, ActorRow | null>(
    async (ids) => {
      const idList = ids as Uuid[];
      const rows = await ctx.db
        .select()
        .from(actorTable)
        .where(inArray(actorTable.id, idList));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return idList.map((id) => byId.get(id) ?? null);
    },
  );
  return ctx.actorByIdLoader.load(actorId);
}

// Builds a Pothos `t.loadable` `load` function for boolean relationship
// fields like `viewerFollows`/`viewerBlocks`/`blocksViewer`/`followsViewer`.
// Each of those fields asks "for these N actor ids, which ones are in the
// directional relationship with the viewer?" and only differs by which
// model helper produces the matched-id Set.  Hoisting the shared shape
// here keeps the field declarations to one line of `load:` each.
function createRelationshipBooleanLoader(
  getMatchedIds: (
    db: UserContext["db"],
    viewerId: Uuid,
    targetIds: readonly Uuid[],
  ) => Promise<Set<Uuid>>,
) {
  return async (
    actorIds: Uuid[],
    ctx: UserContext,
  ): Promise<boolean[]> => {
    if (ctx.account?.actor == null) return actorIds.map(() => false);
    const matched = await getMatchedIds(
      ctx.db,
      ctx.account.actor.id,
      actorIds,
    );
    return actorIds.map((id) => matched.has(id));
  };
}

export const ActorType = builder.enumType("ActorType", {
  description:
    "ActivityPub actor type as defined by the ActivityStreams 2.0 vocabulary. " +
    "Most human accounts are PERSON actors.",
  values: {
    PERSON: {
      description: "A human user account.",
    },
    SERVICE: {
      description: "An automated service or bot account.",
    },
    APPLICATION: {
      description:
        "An application actor, typically the instance software itself.",
    },
    GROUP: {
      description:
        "A group actor; posts addressed to the group are forwarded to members.",
    },
    ORGANIZATION: {
      description: "An organization actor.",
    },
  } as const,
});

export const Actor = builder.drizzleNode("actorTable", {
  name: "Actor",
  description:
    "An ActivityPub actor — the public identity used for federation. " +
    "Actors can be local (originating from this instance, local: true) or " +
    "federated (from another instance, local: false). Local actors have an " +
    "associated Account that holds login credentials and settings; remote " +
    "actors do not. When in doubt, use Actor for display and Account only " +
    "for settings that belong to the authenticated viewer.",
  id: {
    column: (actor) => actor.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.field({
      type: "URL",
      description:
        "The actor's ActivityPub IRI — the canonical identifier used " +
        "for federation. For local actors this is the /ap/… endpoint, " +
        "not the human-readable profile URL. Compare with url, which is " +
        "the web profile page.",
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
      description:
        "True if this actor was created on this instance (has an associated " +
        "local Account). False for actors fetched from remote fediverse " +
        "instances via ActivityPub.",
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
      {
        description:
          "If false, incoming follow requests must be manually approved. " +
          "Pending follows appear with a null accepted timestamp in " +
          "ActorFollowersConnectionEdge until the actor approves them.",
      },
    ),
    avatarUrl: t.field({
      type: "URL",
      select: {
        columns: { avatarUrl: true },
      },
      resolve(actor) {
        const url = getAvatarUrl(actor);
        return new URL(url);
      },
    }),
    avatarInitials: t.field({
      type: "String",
      resolve(actor) {
        const name = actor.name ?? actor.username;
        const parts = name.trim().split(/[\s_-]+/).filter((p) => p.length > 0);
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
      description:
        "The actor's human-readable profile URL. For local actors this is " +
        "the web profile page, which differs from iri (the ActivityPub " +
        "endpoint). Null when the remote instance did not advertise one.",
      resolve(actor) {
        return actor.url ? new URL(actor.url) : null;
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", { type: "DateTime", nullable: true }),
    latestPostUpdated: t.field({
      type: "DateTime",
      nullable: true,
      select: (_args, _ctx, _nestedSelection) => ({
        with: {
          posts: {
            columns: { updated: true },
            orderBy: { updated: "desc" },
            limit: 1,
          },
        },
      }),
      resolve(actor) {
        return actor.posts?.[0]?.updated ?? null;
      },
    }),
    created: t.expose("created", { type: "DateTime" }),
    account: t.relation("account", { nullable: true }),
    instance: t.relation("instance", { type: Instance, nullable: true }),
    successor: t.relation("successor", {
      nullable: true,
      description:
        "If this actor has migrated to a new account via the ActivityPub " +
        "Move activity, points to the new actor. The old actor's posts are " +
        "not automatically transferred to the new account.",
    }),
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
    postByUuid: t.drizzleField({
      type: Post,
      description:
        "Look up one of this actor's posts by any of its UUIDs. Resolves a " +
        "match against any of the three UUIDs a post can carry: `Post.uuid` " +
        "(the post row's PK), `Note.sourceId` (= `noteSourceTable.id`, set " +
        "only on source-backed local notes), or the local article source's " +
        "id. The canonical permalink in `Post.url` uses the source UUID for " +
        "source-backed local posts; for everything else (federated remote " +
        "posts, local share wrappers, Questions) the row PK is the only " +
        "token they can be looked up by, and is what the web-next route " +
        "uses. The OR-match here keeps both styles working. Returns null if " +
        "no post matches.",
      select: { columns: { id: true } },
      nullable: true,
      args: {
        uuid: t.arg({
          type: "UUID",
          required: true,
          description:
            "Any of `Post.uuid`, `Note.sourceId`, or the local article " +
            "source's id.",
        }),
      },
      async resolve(query, actor, args, ctx) {
        if (!validateUuid(args.uuid)) return null;

        const visibility = getPostVisibilityFilter(ctx.account?.actor ?? null);
        return await ctx.db.query.postTable.findFirst(query({
          where: {
            AND: [
              { actorId: actor.id },
              {
                OR: [
                  { id: args.uuid },
                  { noteSourceId: args.uuid },
                  { articleSourceId: args.uuid },
                ],
              },
              visibility,
            ],
          },
        })) ?? null;
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
    description: "One-off check: does this actor follow the given actor? " +
      "For the viewer-relative variant, use viewerFollows instead.",
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
  isViewer: t.field({
    type: "Boolean",
    description:
      "True if this actor belongs to the currently authenticated viewer. " +
      "Always false for unauthenticated requests.",
    resolve(actor, _, ctx) {
      return ctx.account?.actor?.id === actor.id;
    },
  }),
  viewerFollows: t.loadable({
    type: "Boolean",
    description:
      "True if the authenticated viewer follows this actor. Always false " +
      "for unauthenticated requests or when the actor is the viewer themselves.",
    // cache: false so a mutation that changes follow state in the same
    // request (e.g., followActor + read viewerFollows in the payload)
    // re-queries instead of returning the pre-mutation value.
    loaderOptions: { cache: false },
    load: createRelationshipBooleanLoader(getFollowedActorIds),
    resolve: (actor) => actor.id,
  }),
  viewerBlocks: t.loadable({
    type: "Boolean",
    description:
      "True if the authenticated viewer has blocked this actor. Always " +
      "false for unauthenticated requests.",
    // cache: false so blockActor and unblockActor mutations are
    // reflected by subsequent reads of the field within the same
    // request rather than a stale per-request cached value.
    loaderOptions: { cache: false },
    load: createRelationshipBooleanLoader(getBlockedActorIds),
    resolve: (actor) => actor.id,
  }),
  blocksViewer: t.loadable({
    type: "Boolean",
    description:
      "True if this actor has blocked the authenticated viewer. Always " +
      "false for unauthenticated requests.",
    // cache: false so a block-state mutation in the same request is
    // reflected by a subsequent read of the field rather than a
    // stale per-request cached value.
    loaderOptions: { cache: false },
    load: createRelationshipBooleanLoader(getBlockerActorIds),
    resolve: (actor) => actor.id,
  }),
  followsViewer: t.loadable({
    type: "Boolean",
    description:
      "True if this actor follows the authenticated viewer. Always false " +
      "for unauthenticated requests.",
    // cache: false so a follow-state mutation in the same request
    // (e.g., removeFollower) is reflected by a subsequent read of
    // the field rather than a stale per-request cached value.
    loaderOptions: { cache: false },
    load: createRelationshipBooleanLoader(getFollowerActorIds),
    resolve: (actor) => actor.id,
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
    description: "One-off check: is this actor followed by the given actor? " +
      "For the viewer-relative variant, use followsViewer instead.",
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
    query: (_args, ctx) => ({
      orderBy: { created: "desc" },
      where: {
        post: getPostVisibilityFilter(ctx.account?.actor ?? null),
      },
    }),
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
    description:
      "Look up an actor by their internal row UUID (Actor.uuid). Prefer " +
      "actorByHandle for user-facing lookups; this is mainly for internal " +
      "cross-references where a UUID is already known.",
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
    description: "Look up an actor by their fediverse handle (e.g., " +
      "@alice@mastodon.social or alice@hackers.pub). For user@host handles " +
      "not already in the local cache, triggers an outbound WebFinger + " +
      "ActivityPub fetch and persists the result — this only happens for " +
      "authenticated requests, since unauthenticated callers are not " +
      "allowed to spawn outbound federation lookups.",
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
      let actor: ActorRow | undefined = undefined;
      if (split.length === 2) {
        const [username, host] = split;
        actor = await ctx.db.query.actorTable.findFirst(
          query({
            where: {
              username,
              OR: [{ instanceHost: host }, { handleHost: host }],
            },
          }),
        ) as ActorRow | undefined;
      } else if (split.length === 1 && allowLocalHandle) {
        actor = await ctx.db.query.actorTable.findFirst(
          query({
            where: { username: split[0], accountId: { isNotNull: true } },
          }),
        ) as ActorRow | undefined;
      }
      if (actor) return actor;
      // Only `user@host` (with non-empty parts) is a resolvable handle.
      // URLs should go through `actorByUrl`; bare usernames or malformed
      // handles can't be resolved via WebFinger and would otherwise crash
      // on `new URL("…")` inside Fedify.
      if (split.length !== 2 || split[0] === "" || split[1] === "") return null;
      // Guests must not trigger federation lookups: they would let
      // unauthenticated callers spawn outbound WebFinger / actor fetches
      // and persist arbitrary remote actors.
      if (ctx.account == null) return null;
      const documentLoader = await ctx.fedCtx.getDocumentLoader({
        identifier: ctx.account.id,
      });
      let actorObject;
      try {
        actorObject = await ctx.fedCtx.lookupObject(handle, { documentLoader });
      } catch {
        return null;
      }
      if (!isActor(actorObject)) return null;
      return await persistActor(ctx.fedCtx, actorObject, { documentLoader });
    },
  }),
  actorByUrl: t.drizzleField({
    type: Actor,
    description:
      "Look up an actor by their profile URL, resolving via ActivityPub " +
      "when necessary. Only authenticated requests trigger outbound " +
      "federation lookups; unauthenticated callers receive only cached results.",
    args: {
      url: t.arg({ type: "URL", required: true }),
    },
    nullable: true,
    async resolve(query, _, { url }, ctx) {
      const parsed = parseHttpUrl(url.toString());
      if (parsed == null) return null;
      const looked = await lookupActorByUrl(ctx, parsed);
      if (looked == null) return null;
      // Re-fetch through Pothos's drizzle query so selection-driven
      // relations on Actor are loaded.
      return await ctx.db.query.actorTable.findFirst(
        query({ where: { id: looked.id } }),
      );
    },
  }),
  instanceByHost: t.drizzleField({
    type: Instance,
    description:
      "Look up a known fediverse instance by its host name. Returns null " +
      "if this instance has not been discovered yet.",
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
    description:
      "Prefix search for @mention autocomplete. Matches against both " +
      "username and host. Requires authentication to prevent unauthenticated " +
      "callers from triggering outbound federation lookups. Capped at 50 results.",
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

builder.relayMutationField(
  "followActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const followee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (followee == null || followee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await follow(ctx.fedCtx, ctx.account, followee);

      return { followeeId: followee.id, followerId: ctx.account.actor.id };
    },
  },
  {
    outputFields: (t) => ({
      followee: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followeeId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      follower: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followerId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unfollowActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const followee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (followee == null || followee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await unfollow(ctx.fedCtx, ctx.account, followee);

      return { followeeId: followee.id, followerId: ctx.account.actor.id };
    },
  },
  {
    outputFields: (t) => ({
      followee: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followeeId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      follower: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followerId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "removeFollower",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const follower = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (follower == null || follower.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await removeFollowerModel(ctx.fedCtx, ctx.account, follower);

      return {
        followerId: follower.id,
        followeeId: ctx.account.actor.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      follower: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followerId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      followee: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.followeeId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "blockActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const blockee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (blockee == null || blockee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await block(ctx.fedCtx, ctx.account, blockee);

      return {
        blockerId: ctx.account.actor.id,
        blockeeId: blockee.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      blocker: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.blockerId } }),
          );
          return actor!;
        },
      }),
      blockee: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.blockeeId } }),
          );
          return actor!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unblockActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const blockee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (blockee == null || blockee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await unblock(ctx.fedCtx, ctx.account, blockee);

      return {
        blockerId: ctx.account.actor.id,
        blockeeId: blockee.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      blocker: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.blockerId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      blockee: t.drizzleField({
        type: Actor,
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.blockeeId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
    }),
  },
);

builder.queryField("recommendedActors", (t) =>
  t.field({
    type: [Actor],
    description:
      "A small curated list of suggested accounts to follow, weighted " +
      "toward accounts that write in the viewer's preferred locale. " +
      "Capped at 50 results.",
    args: {
      limit: t.arg.int({ required: false, defaultValue: 10 }),
      locale: t.arg({ type: "Locale", required: false }),
    },
    async resolve(_root, args, ctx) {
      const accountLocales = args.locale != null
        ? [args.locale.language]
        : (ctx.account?.locales ?? ["en"]);
      const actors = await recommendActors(ctx.db, {
        mainLocale: accountLocales[0],
        locales: accountLocales,
        account: ctx.account,
        limit: Math.max(1, Math.min(args.limit ?? 10, 50)),
      });
      return actors;
    },
  }));

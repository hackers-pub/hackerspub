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
  getMutualFollowerActorIds,
  getRankedFollowerPage,
  removeFollower as removeFollowerModel,
  unfollow,
} from "@hackerspub/models/following";
import { getMutedActorIds, mute, unmute } from "@hackerspub/models/muting";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import {
  formatTimelineCursor,
  getProfileInteractions,
} from "@hackerspub/models/profile-interactions";
import { type Actor as ActorRow, actorTable } from "@hackerspub/models/schema";
import {
  parseTimelineCursor,
  type TimelineCursor,
} from "@hackerspub/models/timeline";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { resolveOffsetConnection } from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import { escape } from "@std/html/entities";
import { createGraphQLError } from "graphql-yoga";
import xss from "xss";
import { builder, type UserContext } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { lookupActorByUrl, parseHttpUrl } from "./lookup.ts";
import { Article, Note, Post, Question } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

const MAX_VIEWER_INTERACTIONS_WINDOW = 250;

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

function authenticationRequired(): never {
  throw createGraphQLError("Authentication required.", {
    extensions: { code: "AUTHENTICATION_REQUIRED" },
  });
}

function conflictingCursors(): never {
  throw createGraphQLError("Cannot paginate with both after and before.", {
    extensions: { code: "PAGINATION_ERROR" },
  });
}

function getConnectionWindow(
  args: { first?: number | null; last?: number | null },
): number {
  if (args.first != null && args.last != null) {
    throw createGraphQLError("Cannot paginate with both first and last.", {
      extensions: { code: "PAGINATION_ERROR" },
    });
  }
  const window = args.last ?? args.first ?? 25;
  if (window > MAX_VIEWER_INTERACTIONS_WINDOW) {
    throw createGraphQLError(
      `Profile interaction pages are limited to ${MAX_VIEWER_INTERACTIONS_WINDOW} posts.`,
      { extensions: { code: "PAGINATION_ERROR" } },
    );
  }
  return window;
}

function parseRequiredTimelineCursor(raw: string): TimelineCursor {
  const cursor = parseTimelineCursor(raw);
  if (cursor == null) {
    throw createGraphQLError("Invalid timeline cursor.", {
      extensions: { code: "INVALID_CURSOR" },
    });
  }
  return cursor;
}

export const ActorType = builder.enumType("ActorType", {
  description:
    "ActivityPub actor type as defined by the ActivityStreams 2.0 vocabulary. " +
    "Most human accounts are `PERSON` actors.",
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
    "An ActivityPub actor: the public identity used for federation. " +
    "Actors can be local (originating from this instance, `local: true`) or " +
    "federated (from another instance, `local: false`). Local actors have an " +
    "associated `Account` that holds login credentials and settings; remote " +
    "actors do not. When in doubt, use `Actor` for display and `Account` " +
    "only for settings that belong to the authenticated viewer.",
  id: {
    column: (actor) => actor.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.field({
      type: "URL",
      description:
        "The actor's ActivityPub IRI: the canonical identifier used " +
        "for federation. For local actors this is the `/ap/…` endpoint, " +
        "not the human-readable profile URL. Compare with `url`, which is " +
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
        "local `Account`). False for actors fetched from remote fediverse " +
        "instances via ActivityPub.",
      select: {
        columns: { accountId: true },
      },
      resolve(actor) {
        return actor.accountId != null;
      },
    }),
    username: t.exposeString("username"),
    instanceHost: t.exposeString("instanceHost", {
      description:
        "The host of the instance that actually hosts this actor's data, " +
        "as reported by its ActivityPub profile. For most actors this " +
        "equals `handleHost`, but they can differ when an instance uses a " +
        "different domain for WebFinger lookups (e.g., `social.example.com` " +
        "vs. `example.com`).",
    }),
    handleHost: t.exposeString("handleHost", {
      description:
        "The host used in this actor's fediverse handle (`@user@handleHost`). " +
        "This is the domain part that end users type when @-mentioning the actor. " +
        "May differ from `instanceHost` when the instance uses domain aliasing.",
    }),
    handle: t.exposeString("handle", {
      description:
        "Full fediverse handle in `@username@host` format, ready to use " +
        "in @-mentions across the fediverse.",
    }),
    rawName: t.exposeString("name", {
      nullable: true,
      description:
        "The actor's display name as a plain string, before custom emoji " +
        "shortcodes are replaced with `<img>` tags. Use `name` instead " +
        "when rendering to HTML.",
    }),
    name: t.field({
      type: "HTML",
      nullable: true,
      description:
        "The actor's display name rendered as HTML, with custom emoji " +
        "shortcodes replaced by inline `<img>` elements. `null` when the " +
        "actor has no display name set.",
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
      description:
        "The actor's biography rendered as HTML, with custom emoji " +
        "shortcodes replaced by inline `<img>` elements. `null` when " +
        "the actor has no bio.",
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
          "Pending follows appear with a `null` `accepted` timestamp in " +
          "`ActorFollowersConnectionEdge` until the actor approves them.",
      },
    ),
    avatarUrl: t.field({
      type: "URL",
      description:
        "URL of the actor's avatar image. Falls back to a Gravatar URL " +
        "derived from the account's email for local actors without an " +
        "uploaded avatar.",
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
      description:
        "One or two initials derived from the actor's display name or " +
        "username, for use as a text-based avatar placeholder when the " +
        "avatar image is unavailable.",
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
      description:
        "URL of the actor's profile header (banner) image. `null` when " +
        "the actor has not set one.",
      resolve(actor) {
        return actor.headerUrl ? new URL(actor.headerUrl) : null;
      },
    }),
    sensitive: t.exposeBoolean("sensitive", {
      description:
        "Whether this actor has been flagged as posting sensitive (NSFW) " +
        "content. Clients may use this to apply content warnings to the " +
        "actor's posts by default.",
    }),
    url: t.field({
      type: "URL",
      nullable: true,
      description:
        "The actor's human-readable profile URL. For local actors this is " +
        "the web profile page, which differs from `iri` (the ActivityPub " +
        "endpoint). `null` when the remote instance did not advertise one.",
      resolve(actor) {
        return actor.url ? new URL(actor.url) : null;
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    published: t.expose("published", {
      type: "DateTime",
      nullable: true,
      description:
        "When the actor was first published, as reported by the actor's " +
        "ActivityPub profile. `null` for remote actors whose profile did " +
        "not include a published date.",
    }),
    latestPostUpdated: t.field({
      type: "DateTime",
      nullable: true,
      description:
        "The `updated` timestamp of this actor's most recently updated " +
        "post, or `null` if they have no posts. Useful for feed ordering " +
        "without fetching full post connections.",
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
    account: t.relation("account", {
      nullable: true,
      description:
        "The local `Account` for this actor, or `null` for remote actors. " +
        "Non-null only when `local` is `true`.",
    }),
    instance: t.relation("instance", {
      type: Instance,
      nullable: true,
      description:
        "The fediverse instance this actor belongs to. `null` for local " +
        "actors (use the server's own instance info instead).",
    }),
    successor: t.relation("successor", {
      nullable: true,
      description:
        "If this actor has migrated to a new account via the ActivityPub " +
        "Move activity, points to the new actor. The old actor's posts " +
        "are not automatically transferred to the new account.",
    }),
    fields: t.field({
      type: [ActorFieldRef],
      description:
        "Key-value metadata fields from the actor's ActivityPub profile " +
        "(the `attachment` property). Commonly used for website links, " +
        "pronouns, or other structured profile information. Values are " +
        "rendered as HTML.",
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
      description:
        "All of this actor's posts (Notes, Articles, Questions, and " +
        "boost wrappers), newest published first. Filtered to posts " +
        "visible to the current viewer.",
      query: (_, ctx) => ({
        where: getPostVisibilityFilter(ctx.account?.actor ?? null),
        orderBy: { published: "desc" },
      }),
    }),
    notes: t.relatedConnection("posts", {
      type: Note,
      description:
        "This actor's `Note`-type posts, newest first, filtered to those " +
        "visible to the viewer. Includes both original notes and boost " +
        "wrappers of remote notes. Use `sharedPosts` to see only boosts.",
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
      description:
        "This actor's locally-authored `Article`-type posts, newest first. " +
        "Only includes articles that have a local `articleSource` row; " +
        "remote articles federated in from other instances are excluded.",
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
      description:
        "This actor's `Question`-type posts (polls), newest first, " +
        "filtered to those visible to the viewer.",
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
      description:
        "Posts that this actor has boosted (shared), newest first. " +
        "These are boost wrapper rows where `sharedPost` is non-null.",
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
      description:
        "Posts this actor has pinned to the top of their profile, most " +
        "recently pinned first. Only posts visible to the current viewer " +
        "are included.",
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
      description:
        "This actor's followers (accepted follows only). Ordered so that the " +
        'followers the authenticated viewer also follows ("followers you ' +
        'know") come first, then the rest most recently followed first; for ' +
        "an unauthenticated viewer there are no mutual followers, so it is " +
        "simply most recent first. `totalCount` counts every accepted " +
        "follower regardless of viewer.",
      select: { columns: { id: true, followersCount: true } },
      resolve: async (actor, args, ctx) => {
        const viewerId = ctx.account?.actor?.id ?? null;
        const connection = await resolveOffsetConnection(
          { args, totalCount: actor.followersCount },
          ({ offset, limit }) =>
            getRankedFollowerPage(ctx.db, viewerId, actor.id, limit, offset),
        );
        // Re-shape each edge so the node is the follower actor while the
        // follow row's `iri`/`accepted`/`created` stay available as edge
        // fields (matching the connection's original schema).
        return {
          ...connection,
          edges: connection.edges.map((edge) => ({
            cursor: edge.cursor,
            node: edge.node.follower,
            iri: edge.node.iri,
            accepted: edge.node.accepted,
            created: edge.node.created,
          })),
        };
      },
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
  mutualFollowers: t.connection(
    {
      type: Actor,
      description:
        'The "followers you know": actors the authenticated viewer follows ' +
        "who also follow this actor (both follows accepted). Returns an empty " +
        "connection for unauthenticated viewers and when this actor is the " +
        "viewer themselves. Ordered by the profile-side follow, newest first. " +
        'Use this for a "followed by people you know" hint on profiles; for ' +
        "the complete follower list use `followers` instead.",
      resolve: async (actor, args, ctx) => {
        if (ctx.account?.actor == null || ctx.account.actor.id === actor.id) {
          return resolveOffsetConnection({ args, totalCount: 0 }, () => []);
        }
        const ids = await getMutualFollowerActorIds(
          ctx.db,
          ctx.account.actor.id,
          actor.id,
        );
        return resolveOffsetConnection(
          { args, totalCount: ids.length },
          async ({ offset, limit }) => {
            const rows = await Promise.all(
              ids.slice(offset, offset + limit).map((id) =>
                getActorById(ctx, id)
              ),
            );
            return rows.filter((row) => row != null);
          },
        );
      },
    },
    {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    },
  ),
  viewerInteractions: t.connection({
    type: Post,
    description:
      "Posts authored by either this `Actor` or the authenticated viewer " +
      "that directly involve the other actor through a reply, quote, or " +
      "explicit mention. Returns an empty connection for the viewer's own " +
      "`Actor`; unauthenticated requests raise `AUTHENTICATION_REQUIRED`. " +
      "`first` and `last` are capped at 250 posts.",
    async resolve(actor, args, ctx) {
      if (ctx.account == null) {
        authenticationRequired();
      } else if (args.after != null && args.before != null) {
        conflictingCursors();
      }
      const backwards = args.last != null;
      const window = getConnectionWindow(args);
      const since = args.before == null
        ? undefined
        : parseRequiredTimelineCursor(args.before);
      const until = args.after == null
        ? undefined
        : parseRequiredTimelineCursor(args.after);
      const interactions = await getProfileInteractions(ctx.db, {
        viewer: ctx.account,
        profileActorId: actor.id,
        direction: backwards ? "backward" : "forward",
        window: window + 1,
        since,
        until,
      });
      const pageEntries = interactions.slice(0, window);
      if (backwards) pageEntries.reverse();
      return {
        pageInfo: {
          hasNextPage: backwards
            ? args.before != null && interactions.length > window
            : interactions.length > window,
          hasPreviousPage: backwards
            ? interactions.length > window
            : args.after != null,
          startCursor: pageEntries.length < 1
            ? null
            : formatTimelineCursor(pageEntries[0]),
          endCursor: pageEntries.length < 1
            ? null
            : formatTimelineCursor(pageEntries[pageEntries.length - 1]),
        },
        edges: pageEntries.map((entry) => ({
          node: entry.post,
          cursor: formatTimelineCursor(entry),
        })),
      };
    },
  }),
  follows: t.field({
    type: "Boolean",
    description: "One-off check: does this actor follow the given actor? " +
      "For the viewer-relative variant, use `viewerFollows` instead.",
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
  viewerMutes: t.loadable({
    type: "Boolean",
    description:
      "True if the authenticated viewer has muted this actor. Always `false` " +
      "for unauthenticated requests. Muting is local-only and one-directional: " +
      "it hides the actor from the viewer's feeds and suppresses notifications " +
      "from them (except replies and mentions when the viewer also follows " +
      "them), but unlike `viewerBlocks` it does not federate and the actor " +
      "remains visible on their profile and in threads.",
    // cache: false so muteActor and unmuteActor mutations are reflected by
    // subsequent reads of the field within the same request rather than a
    // stale per-request cached value.
    loaderOptions: { cache: false },
    load: createRelationshipBooleanLoader(getMutedActorIds),
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
      "For the viewer-relative variant, use `followsViewer` instead.",
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
  mutedActors: t.connection({
    type: Actor,
    description:
      "Actors the authenticated viewer has muted, most recently muted first. " +
      "Only readable for the viewer's own actor: querying another actor's " +
      "`mutedActors` (or querying as a guest) yields an empty connection, since " +
      "a mute list is private. Use this to build a mute-management view; the " +
      "per-actor boolean check is `viewerMutes`.",
    select: (args, ctx, nestedSelection) => ({
      with: {
        mutees: muteeConnectionHelpers.getQuery(args, ctx, nestedSelection),
      },
    }),
    resolve: (actor, args, ctx) =>
      muteeConnectionHelpers.resolve(
        ctx.account?.actor.id === actor.id ? actor.mutees : [],
        args,
        ctx,
      ),
  }),
  blockedActors: t.connection({
    type: Actor,
    description:
      "Actors the authenticated viewer has blocked, most recently blocked " +
      "first. Only readable for the viewer's own actor: querying another " +
      "actor's `blockedActors` (or querying as a guest) yields an empty " +
      "connection, since a block list is private. Use this to build a " +
      "block-management view; the per-actor boolean check is `viewerBlocks`.",
    select: (args, ctx, nestedSelection) => ({
      with: {
        blockees: blockeeConnectionHelpers.getQuery(args, ctx, nestedSelection),
      },
    }),
    resolve: (actor, args, ctx) =>
      blockeeConnectionHelpers.resolve(
        ctx.account?.actor.id === actor.id ? actor.blockees : [],
        args,
        ctx,
      ),
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

const muteeConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "mutingTable",
  {
    query: () => ({ orderBy: { created: "desc" } }),
    select: (nodeSelection) => ({
      with: {
        mutee: nodeSelection({}),
      },
    }),
    resolveNode: (muting) => muting.mutee,
  },
);

const blockeeConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "blockingTable",
  {
    query: () => ({ orderBy: { created: "desc" } }),
    select: (nodeSelection) => ({
      with: {
        blockee: nodeSelection({}),
      },
    }),
    resolveNode: (blocking) => blocking.blockee,
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
      "Look up an actor by their internal row UUID (`Actor.uuid`). Prefer " +
      "`actorByHandle` for user-facing lookups; this is mainly for internal " +
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
      "`@alice@mastodon.social` or `alice@hackers.pub`). For `user@host` " +
      "handles not already in the local cache, triggers an outbound " +
      "WebFinger + ActivityPub fetch and persists the result; this only " +
      "happens for authenticated requests, since unauthenticated callers " +
      "are not allowed to spawn outbound federation lookups.",
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
      "Look up a known fediverse instance by its host name. Returns `null` " +
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
    description:
      "Remove an `Actor` from the authenticated viewer's followers. " +
      "This deletes the follower relationship without blocking the actor; " +
      "remote followers receive an ActivityPub `Reject` for the original " +
      "`Follow`.",
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
        description: "`Actor` global ID for the follower to remove from the " +
          "authenticated viewer's followers. Passing the viewer's own actor " +
          "or an unknown actor returns `InvalidInputError`.",
      }),
    }),
  },
  {
    description:
      "Remove an `Actor` from the authenticated viewer's followers. " +
      "This deletes the follower relationship without blocking the actor; " +
      "remote followers receive an ActivityPub `Reject` for the original " +
      "`Follow`.",
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
      union: {
        description:
          "Result of removing a follower: the updated actors on success, " +
          "or a typed authentication or input error.",
      },
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
    description:
      "Payload returned after successfully removing a follower. Contains the " +
      "updated viewer `Actor` and removed follower `Actor` so clients can " +
      "refresh counts and relationship state.",
    outputFields: (t) => ({
      follower: t.drizzleField({
        type: Actor,
        description:
          "The removed follower `Actor`. The actor may follow the viewer " +
          "again later unless separately blocked.",
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
        description:
          "The authenticated viewer's `Actor` whose follower list changed.",
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

builder.relayMutationField(
  "muteActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
        description: "The global ID of the `Actor` to mute.",
      }),
    }),
  },
  {
    description:
      "Mutes an actor on behalf of the authenticated viewer. Muting is " +
      "local-only and one-directional: it hides the actor from the viewer's " +
      "feeds and suppresses notifications from them (except replies and " +
      "mentions when the viewer also follows them), but unlike `blockActor` it " +
      "does not federate, does not remove follow relationships, and leaves the " +
      "actor visible on their profile and in threads. Idempotent: muting an " +
      "already-muted actor succeeds. Rejects muting yourself with " +
      "`InvalidInputError`.",
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      if (!validateUuid(args.input.actorId.id)) {
        throw new InvalidInputError("actorId");
      }

      const mutee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (mutee == null || mutee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await mute(ctx.db, ctx.account, mutee);

      return {
        muterId: ctx.account.actor.id,
        muteeId: mutee.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      muter: t.drizzleField({
        type: Actor,
        description: "The viewer's actor that performed the mute.",
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.muterId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      mutee: t.drizzleField({
        type: Actor,
        description: "The actor that was muted.",
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.muteeId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unmuteActor",
  {
    inputFields: (t) => ({
      actorId: t.globalID({
        for: [Actor],
        required: true,
        description: "The global ID of the `Actor` to unmute.",
      }),
    }),
  },
  {
    description:
      "Removes a mute previously created by `muteActor` on behalf of the " +
      "authenticated viewer. Idempotent: unmuting an actor that was not muted " +
      "succeeds. Rejects targeting yourself with `InvalidInputError`.",
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      if (!validateUuid(args.input.actorId.id)) {
        throw new InvalidInputError("actorId");
      }

      const mutee = await ctx.db.query.actorTable.findFirst({
        where: { id: args.input.actorId.id },
      });

      if (mutee == null || mutee.accountId === session.accountId) {
        throw new InvalidInputError("actorId");
      }

      await unmute(ctx.db, ctx.account, mutee);

      return {
        muterId: ctx.account.actor.id,
        muteeId: mutee.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      muter: t.drizzleField({
        type: Actor,
        description: "The viewer's actor that performed the unmute.",
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.muterId } }),
          );
          assert(actor != undefined);

          return actor;
        },
      }),
      mutee: t.drizzleField({
        type: Actor,
        description: "The actor that was unmuted.",
        async resolve(query, result, _args, ctx) {
          const actor = await ctx.db.query.actorTable.findFirst(
            query({ where: { id: result.muteeId } }),
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

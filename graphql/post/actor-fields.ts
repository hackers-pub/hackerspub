import { resolveOffsetConnection } from "@pothos/plugin-relay";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
} from "@hackerspub/models/post/visibility";
import {
  formatTimelineCursor,
  getProfileInteractions,
} from "@hackerspub/models/profile-interactions";
import { validateUuid } from "@hackerspub/models/uuid";
import { resolveActingAccountForGlobalIdArg } from "../acting-account.ts";
import {
  Actor,
  authenticationRequired,
  conflictingCursors,
  getActorById,
  getConnectionWindow,
  loadActorProfilePostPage,
  parseRequiredTimelineCursor,
  pinConnectionHelpers,
} from "../actor.ts";
import { builder } from "../builder.ts";
import {
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "../viewer-actor.ts";
import { Article } from "./article.ts";
import { Post } from "./core.ts";
import { Note, Question } from "./note.ts";

builder.drizzleObjectFields(Actor, (t) => ({
  posts: t.connection({
    type: Post,
    description: "All of this actor's posts (Notes, Articles, Questions, and " +
      "boost wrappers), newest published first. Filtered to posts " +
      "visible to the selected viewer account. Pass `actingAccountId` " +
      "for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(actor, args, ctx) {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor = viewerActorId == null
        ? null
        : await getActorById(ctx, viewerActorId);
      return await resolveOffsetConnection(
        { args },
        async ({ offset, limit }) => {
          const postPage = await ctx.db.query.postTable.findMany({
            where: {
              AND: [
                { actorId: actor.id },
                getPostVisibilityFilter(viewerActor),
                getCensoredPostExclusionFilter(viewerActor?.id),
              ],
            },
            orderBy: { published: "desc" },
            limit,
            offset,
          });
          return await loadActorProfilePostPage(ctx, postPage, viewerActorId);
        },
      );
    },
  }),
  notes: t.connection({
    type: Note,
    description:
      "This actor's `Note`-type posts, newest first, filtered to those " +
      "visible to the viewer. Includes both original notes and boost " +
      "wrappers of remote notes. Use `sharedPosts` to see only boosts. " +
      "Pass `actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(actor, args, ctx) {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor = viewerActorId == null
        ? null
        : await getActorById(ctx, viewerActorId);
      return await resolveOffsetConnection(
        { args },
        async ({ offset, limit }) => {
          const postPage = await ctx.db.query.postTable.findMany({
            where: {
              AND: [
                { actorId: actor.id },
                { type: "Note" },
                getPostVisibilityFilter(viewerActor),
                getCensoredPostExclusionFilter(viewerActor?.id),
              ],
            },
            orderBy: { published: "desc" },
            limit,
            offset,
          });
          return await loadActorProfilePostPage(ctx, postPage, viewerActorId);
        },
      );
    },
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
      "on source-backed local notes and Questions), or the local article " +
      "source's id. The canonical permalink in `Post.url` uses the source " +
      "UUID for source-backed local posts, including local `Question`s. " +
      "For posts without a local source row (federated remote posts and " +
      "local share wrappers), the row PK is the lookup token. The OR-match " +
      "here keeps both styles working. Returns `null` if no post matches " +
      "or the post is not visible to the selected viewer account.",
    select: { columns: { id: true } },
    nullable: true,
    args: {
      uuid: t.arg({
        type: "UUID",
        required: true,
        description:
          "Any of `Post.uuid`, `Note.sourceId` (also used by local " +
          "`Question`s), or the local article source's id.",
      }),
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(query, actor, args, ctx) {
      if (!validateUuid(args.uuid)) return null;

      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor = viewerActorId == null
        ? null
        : await getActorById(ctx, viewerActorId);
      const visibility = getPostVisibilityFilter(viewerActor);
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
  articles: t.connection({
    type: Article,
    description:
      "This actor's locally-authored `Article`-type posts, newest first. " +
      "Only includes articles that have a local `articleSource` row; " +
      "remote articles federated in from other instances are excluded. " +
      "Pass `actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(actor, args, ctx) {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor = viewerActorId == null
        ? null
        : await getActorById(ctx, viewerActorId);
      return await resolveOffsetConnection(
        { args },
        async ({ offset, limit }) => {
          const postPage = await ctx.db.query.postTable.findMany({
            where: {
              AND: [
                { actorId: actor.id },
                { type: "Article" },
                {
                  articleSourceId: {
                    isNotNull: true,
                  },
                },
                getPostVisibilityFilter(viewerActor),
                getCensoredPostExclusionFilter(viewerActor?.id),
              ],
            },
            orderBy: { published: "desc" },
            limit,
            offset,
          });
          return await loadActorProfilePostPage(ctx, postPage, viewerActorId);
        },
      );
    },
  }),
  questions: t.relatedConnection("posts", {
    type: Question,
    description: "This actor's `Question`-type posts (polls), newest first, " +
      "filtered to those visible to the viewer.",
    query: (_, ctx) => ({
      where: {
        AND: [
          { type: "Question" },
          getPostVisibilityFilter(ctx.account?.actor ?? null),
          getCensoredPostExclusionFilter(ctx.account?.actor.id),
        ],
      },
      orderBy: { published: "desc" },
    }),
  }),
  sharedPosts: t.connection({
    type: Post,
    description: "Posts that this actor has boosted (shared), newest first. " +
      "These are boost wrapper rows where `sharedPost` is non-null. " +
      "Pass `actingAccountId` for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(actor, args, ctx) {
      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor = viewerActorId == null
        ? null
        : await getActorById(ctx, viewerActorId);
      return await resolveOffsetConnection(
        { args },
        async ({ offset, limit }) => {
          const postPage = await ctx.db.query.postTable.findMany({
            where: {
              AND: [
                { actorId: actor.id },
                getPostVisibilityFilter(viewerActor),
                getCensoredPostExclusionFilter(viewerActor?.id),
                { sharedPostId: { isNotNull: true } },
              ],
            },
            orderBy: { published: "desc" },
            limit,
            offset,
          });
          return await loadActorProfilePostPage(ctx, postPage, viewerActorId);
        },
      );
    },
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
  viewerInteractions: t.connection({
    type: Post,
    description:
      "Posts authored by either this `Actor` or the selected viewer account " +
      "that directly involve the other actor through a reply, quote, or " +
      "explicit mention. Returns an empty connection for the viewer's own " +
      "`Actor`; unauthenticated requests raise `AUTHENTICATION_REQUIRED`. " +
      "`first` and `last` are capped at 250 posts. Pass `actingAccountId` " +
      "for an organization perspective.",
    args: {
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(actor, args, ctx) {
      if (ctx.account == null) {
        authenticationRequired();
      } else if (args.after != null && args.before != null) {
        conflictingCursors();
      }
      const actingAccount = await resolveActingAccountForGlobalIdArg(ctx, args);
      const backwards = args.last != null;
      const window = getConnectionWindow(args);
      const since = args.before == null
        ? undefined
        : parseRequiredTimelineCursor(args.before);
      const until = args.after == null
        ? undefined
        : parseRequiredTimelineCursor(args.after);
      const interactions = await getProfileInteractions(ctx.db, {
        viewer: actingAccount,
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
            ? args.before != null
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
}));

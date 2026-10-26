import type { Uuid } from "@hackerspub/models/uuid";
import DataLoader from "dataloader";
import type { GraphQLResolveInfo } from "graphql";
import { resolveActingAccountForGlobalIdArg } from "../acting-account.ts";
import { builder, type UserContext } from "../builder.ts";
import { Reactable } from "../reactable.ts";
import { createRequestCache } from "../request-cache.ts";
import { actingAccountIdArgDescription } from "../viewer-actor.ts";
import { Post } from "./core.ts";

const noteSourceContentLoaders = createRequestCache((ctx, operation) => ({
  db: ctx.db,
  // Query-side writes do not change note Markdown. Each mutation payload must
  // read again, including two updates of the same note in a single operation.
  cache: operation.operation === "query",
  byAccount: new Map<Uuid, DataLoader<Uuid, string | null>>(),
}));

function loadNoteSourceContent(
  sourceId: Uuid,
  accountId: Uuid,
  ctx: UserContext,
  info: GraphQLResolveInfo,
): Promise<string | null> {
  const { db, cache, byAccount } = noteSourceContentLoaders(ctx, info);
  let loader = byAccount.get(accountId);
  if (loader == null) {
    loader = new DataLoader<Uuid, string | null>(
      async (ids) => {
        const rows = await db.query.noteSourceTable.findMany({
          where: { id: { in: [...new Set(ids)] }, accountId },
          columns: { id: true, content: true },
        });
        const contents = new Map(rows.map((row) => [row.id, row.content]));
        return ids.map((id) => contents.get(id) ?? null);
      },
      { cache },
    );
    // Account-scoped loaders map exact (source, owner) pairs, never a cross
    // product of source IDs and selected account IDs.
    byAccount.set(accountId, loader);
  }
  return loader.load(sourceId);
}

export const Note = builder.drizzleNode("postTable", {
  select: { columns: { id: true, type: true, reactionsCounts: true } },
  variant: "Note",
  description:
    "A short-form microblog post, equivalent to a Mastodon Status or " +
    "ActivityPub Note. Notes can be composed locally or federated in from " +
    "remote instances. Boost wrappers (`sharedPost` is non-null) have empty " +
    "content and copy the shared post's URL.",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    sourceId: t.expose("noteSourceId", {
      type: "UUID",
      nullable: true,
      description:
        "The local source UUID for this note — `noteSourceTable.id`, the " +
        "identifier embedded in `Post.url` (`/@username/<sourceId>`). " +
        "Non-null only for source-backed local notes (notes originally " +
        "composed on this instance). Null for federated remote notes and for " +
        "local share wrappers (boosts), since neither carries a " +
        "`noteSourceTable` row; for those, fall back to `Post.uuid`.",
    }),
    rawContent: t.field({
      type: "Markdown",
      nullable: true,
      description:
        "The raw Markdown source of this note. Non-null only when the " +
        "viewer is the note's author. Pass `actingAccountId` to read the " +
        "source of a note authored by an organization account the viewer " +
        "belongs to. Returns `null` for federated remote notes, local share " +
        "wrappers, and notes authored by someone else.",
      args: {
        actingAccountId: t.arg.id({
          required: false,
          description: actingAccountIdArgDescription,
        }),
      },
      select: {
        columns: { noteSourceId: true },
        with: { noteSource: { columns: { accountId: true } } },
      },
      async resolve(post, args, ctx, info) {
        if (post.noteSource == null || post.noteSourceId == null) return null;
        if (ctx.account == null) return null;
        const actingAccount = await resolveActingAccountForGlobalIdArg(
          ctx,
          args,
        );
        if (actingAccount.id !== post.noteSource.accountId) return null;
        return await loadNoteSourceContent(
          post.noteSourceId,
          actingAccount.id,
          ctx,
          info,
        );
      },
    }),
  }),
});

export const Question = builder.drizzleNode("postTable", {
  select: { columns: { id: true, type: true, reactionsCounts: true } },
  variant: "Question",
  description:
    "An ActivityPub `Question` poll. Local Questions are source-backed " +
    "short posts with immutable poll settings; remote Questions may have " +
    "`null` for `sourceId`. Use `Question.sourceId` for source-backed local " +
    "Question routes, and fall back to `Post.uuid` for federated remote " +
    "Questions and local share wrappers.",
  interfaces: [Post, Reactable],
  id: {
    column: (post) => post.id,
  },
  fields: (t) => ({
    sourceId: t.expose("noteSourceId", {
      type: "UUID",
      nullable: true,
      description:
        "The local source UUID for this question (`noteSourceTable.id`), " +
        "embedded in source-backed local Question URLs as " +
        "`/@username/<sourceId>`. `null` for federated remote questions and " +
        "local share wrappers; use `Post.uuid` as the fallback route token.",
    }),
  }),
});

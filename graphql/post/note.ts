import { resolveActingAccountForGlobalIdArg } from "../acting-account.ts";
import { builder } from "../builder.ts";
import { Reactable } from "../reactable.ts";
import { actingAccountIdArgDescription } from "../viewer-actor.ts";
import { Post } from "./core.ts";

export const Note = builder.drizzleNode("postTable", {
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
        with: { noteSource: { columns: { content: true, accountId: true } } },
      },
      async resolve(post, args, ctx) {
        if (post.noteSource == null) return null;
        if (ctx.account == null) return null;
        const actingAccount = await resolveActingAccountForGlobalIdArg(
          ctx,
          args,
        );
        if (actingAccount.id !== post.noteSource.accountId) return null;
        return post.noteSource.content;
      },
    }),
  }),
});

export const Question = builder.drizzleNode("postTable", {
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

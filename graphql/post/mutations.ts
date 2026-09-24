// Mutation and query registration for posts.
import { assertNever } from "@std/assert/unstable-never";
import { eq } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import {
  acknowledgeArticleTranslation,
  type ArticleAdditionalContent,
  createArticle,
  deleteArticleDraft,
  getAccessibleArticleDraft,
  getOriginalArticleContent,
  LanguageChangeWithTranslationsError,
  moveArticleDraftToOrganization,
  promoteArticleTranslationDrafts,
  publishArticleTranslation,
  saveArticleDraft,
  startArticleContentTranslation,
  updateArticle,
  withdrawArticleTranslation,
} from "@hackerspub/models/article";
import { getCurrentDraftRevision } from "@hackerspub/models/article-revision";
import {
  deleteArticleTranslationDraft,
  saveArticleTranslationDraft,
} from "@hackerspub/models/article-translation";
import {
  arePostsBookmarkedBy,
  createBookmark,
  deleteBookmark,
} from "@hackerspub/models/bookmark";
import { isReactionEmoji, type ReactionEmoji } from "@hackerspub/models/emoji";
import {
  normalizeContentLanguage,
  normalizeLocale,
} from "@hackerspub/models/i18n";
import {
  createMediumFromBytes,
  createMediumFromUrl,
  MAX_STREAMING_MEDIUM_IMAGE_SIZE,
  SUPPORTED_MEDIUM_IMAGE_TYPES,
  UnsafeMediumUrlError,
} from "@hackerspub/models/medium";
import {
  createNote,
  QuotePolicyDeniedError,
  updateNote,
} from "@hackerspub/models/note";
import {
  canAccountActAs,
  OrganizationPermissionError,
} from "@hackerspub/models/organization";
import {
  pinPost as pinPostModel,
  unpinPost as unpinPostModel,
} from "@hackerspub/models/pin";
import { revokeQuote as revokeQuoteModel } from "@hackerspub/models/post/engagement";
import { deletePost } from "@hackerspub/models/post/lifecycle";
import { sharePost, unsharePost } from "@hackerspub/models/post/sharing";
import {
  canActorRequestQuotePost,
  getPostVisibilityFilter,
  isPostVisibleTo,
  normalizeQuotePolicyForVisibility,
} from "@hackerspub/models/post/visibility";
import { InvalidPollInputError } from "@hackerspub/models/poll";
import { createQuestion } from "@hackerspub/models/question";
import { react, undoReaction } from "@hackerspub/models/reaction";
import {
  articleDraftMediumTable,
  articleDraftTable,
  articleSourceMediumTable,
  articleTranslationDraftTable,
} from "@hackerspub/models/schema";
import type * as schema from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Account } from "../account.ts";
import {
  resolveActingAccountForGlobalIdArg,
  resolveActingAccountForMutation,
} from "../acting-account.ts";
import { getActorById } from "../actor.ts";
import { builder } from "../builder.ts";
import {
  ActorSuspendedError,
  InvalidInputError,
  NotAuthorizedError,
} from "../error.ts";
import { lookupPostByUrl, parseHttpUrl } from "../lookup.ts";
import {
  createMediumUploadSession,
  deleteMediumUploadSession,
  getMediumUploadSession,
  isMediumOwner,
  isMediumUploadWindowActive,
  MEDIUM_UPLOAD_TTL_MS,
  setMediumOwner,
} from "../medium-upload.ts";
import { PostVisibility } from "../postvisibility.ts";
import { fromQuotePolicy, QuotePolicy } from "../quotepolicy.ts";
import { CustomEmoji, Reaction } from "../reactable.ts";
import { NotAuthenticatedError } from "../session.ts";
import {
  actingAccountIdArgDescription,
  resolveViewerActorId,
} from "../viewer-actor.ts";
import {
  assertActingAccountNotSuspended,
  isPostVisibleToViewer,
  LlmTranslationNotAllowedError,
  logger,
  Medium,
  MediumUploadHeader,
  Post,
  PostAttributionMode,
  recordPostActingAccount,
  resolvePostActingAccount,
  resolvePostManagementActingAccount,
  type ResolvedPostActingAccount,
  SharedPostDeletionNotAllowedError,
} from "./core.ts";
import { Note, Question } from "./note.ts";
import {
  Article,
  ArticleContent,
  ArticleDraft,
  ArticleDraftConflictError,
  ArticleTranslationDraft,
  ArticleTranslationProvenance,
} from "./article.ts";

export {
  hidePostRelationWithoutActor,
  isPostVisibleToViewer,
  Medium,
  Post,
  PostLink,
  PostType,
} from "./core.ts";
export { Note, Question } from "./note.ts";
export { Article, ArticleContent, ArticleDraft } from "./article.ts";

const CreateNoteMediumInput = builder.inputType("CreateNoteMediumInput", {
  fields: (t) => ({
    mediumId: t.field({
      type: "UUID",
      required: true,
      description: "UUID of a Medium to attach to the note.",
    }),
    alt: t.string({
      required: true,
      description: "Alternative text for this note's use of the medium.",
    }),
  }),
});

const CreateQuestionPollInput = builder.inputType("CreateQuestionPollInput", {
  description:
    "Immutable poll settings for `createQuestion`. These settings cannot " +
    "be edited after the Question is published.",
  fields: (t) => ({
    title: t.string({
      required: true,
      description:
        "Poll title used as the ActivityPub `Question.name`. Must be " +
        "between `1` and `200` characters after trimming.",
    }),
    multiple: t.boolean({
      required: true,
      description:
        "Whether voters may choose more than one option. `false` creates " +
        "an ActivityPub Question with exclusive options.",
    }),
    options: t.stringList({
      required: true,
      description:
        "Poll option labels in display order. Must contain between `2` " +
        "and `20` unique, non-empty entries after trimming.",
    }),
    ends: t.field({
      type: "DateTime",
      required: true,
      description:
        "Voting deadline. Must be at least `1` minute and at most `1` " +
        "year in the future.",
    }),
  }),
});

builder.relayMutationField(
  "createNote",
  {
    description:
      "Publish a new short-form note. Sends an ActivityPub `Create` " +
      "activity to relevant inboxes based on `visibility`. Requires " +
      "authentication.",
    inputFields: (t) => ({
      visibility: t.field({ type: PostVisibility, required: true }),
      content: t.field({ type: "Markdown", required: true }),
      language: t.field({ type: "Locale", required: true }),
      quotePolicy: t.field({ type: QuotePolicy, required: false }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to publish as. Omit to publish as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to publish as that " +
          "organization.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the personal member when `actingAccountId` is " +
          "an organization. Defaults to `ACTING_ACCOUNT_ONLY`; invalid " +
          "when publishing as a personal account.",
      }),
      media: t.field({
        type: [CreateNoteMediumInput],
        required: false,
        defaultValue: [],
        description: "Media to attach to the note, in display order.",
      }),
      replyTargetId: t.globalID({
        for: [Note, Article, Question],
        required: false,
      }),
      quotedPostId: t.globalID({
        for: [Note, Article, Question],
        required: false,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const authenticatedAccountId = ctx.account.id;
      const {
        visibility,
        content,
        language,
        quotePolicy,
        media,
        replyTargetId,
        quotedPostId,
      } = args.input;
      const actingAccount = await resolvePostActingAccount(ctx, args.input);
      const attachedMedia = media ?? [];
      if (attachedMedia.length > 20) {
        throw new InvalidInputError("media");
      }
      let replyTarget: (schema.Post & { actor: schema.Actor }) | undefined;
      if (replyTargetId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: replyTargetId.id },
        });
        if (post == null) {
          throw new InvalidInputError("replyTargetId");
        }
        const effectivePost = post.sharedPost ?? post;
        if (
          !isPostVisibleTo(post, actingAccount.account.actor) ||
          !isPostVisibleTo(effectivePost, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("replyTargetId");
        }
        replyTarget = post;
      }
      let quotedPost: (schema.Post & { actor: schema.Actor }) | undefined;
      if (quotedPostId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: quotedPostId.id },
        });
        if (
          post == null ||
          !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        // Validate against the effective original post to prevent bypassing
        // via a public share wrapper of a non-quotable original.
        const effectivePost = post.sharedPost ?? post;
        if (effectivePost.sharedPostId != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (!isPostVisibleTo(effectivePost, actingAccount.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        // Neither a censored post nor a censored share wrapper can be
        // quoted; the model revalidates, but the submitted row is
        // unwrapped here, so the wrapper must be checked here too.
        if (post.censored != null || effectivePost.censored != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (
          !canActorRequestQuotePost(effectivePost, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        quotedPost = effectivePost;
      }
      return await withTransaction(ctx.fedCtx, async (context) => {
        const noteMedia = await Promise.all(
          attachedMedia.map(async (medium, i) => {
            const alt = medium.alt.trim();
            if (alt === "") throw new InvalidInputError(`media.${i}.alt`);
            const storedMedium = await context.db.query.mediumTable.findFirst({
              where: { id: medium.mediumId },
            });
            if (storedMedium == null) {
              throw new InvalidInputError(`media.${i}.mediumId`);
            }
            return { mediumId: medium.mediumId, alt };
          }),
        );
        let note: Awaited<ReturnType<typeof createNote>>;
        await assertActingAccountNotSuspended(
          ctx.db,
          authenticatedAccountId,
          actingAccount.account.id,
        );
        try {
          note = await createNote(
            context,
            {
              accountId: actingAccount.account.id,
              visibility:
                visibility === "PUBLIC"
                  ? "public"
                  : visibility === "UNLISTED"
                    ? "unlisted"
                    : visibility === "FOLLOWERS"
                      ? "followers"
                      : visibility === "DIRECT"
                        ? "direct"
                        : visibility === "NONE"
                          ? "none"
                          : assertNever(
                              visibility,
                              `Unknown value in Post.visibility: "${visibility}"`,
                            ),
              quotePolicy: normalizeQuotePolicyForVisibility(
                visibility === "PUBLIC"
                  ? "public"
                  : visibility === "UNLISTED"
                    ? "unlisted"
                    : visibility === "FOLLOWERS"
                      ? "followers"
                      : visibility === "DIRECT"
                        ? "direct"
                        : visibility === "NONE"
                          ? "none"
                          : assertNever(
                              visibility,
                              `Unknown value in Post.visibility: "${visibility}"`,
                            ),
                quotePolicy == null ? undefined : fromQuotePolicy(quotePolicy),
              ),
              content,
              language: language.baseName,
              media: noteMedia,
            },
            { replyTarget, quotedPost },
            {
              afterPostCreated: (post, db) =>
                recordPostActingAccount(db, post.id, actingAccount),
            },
          );
        } catch (error) {
          if (error instanceof QuotePolicyDeniedError) {
            throw new InvalidInputError("quotedPostId");
          }
          throw error;
        }
        if (note == null) {
          throw createGraphQLError("Failed to create note.", {
            originalError: new Error("Failed to create note."),
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        }
        return note;
      });
    },
  },
  {
    outputFields: (t) => ({
      note: t.field({
        type: Note,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "createQuestion",
  {
    description:
      "Publish a new short-form post with an immutable ActivityPub " +
      "`Question` poll. Sends an ActivityPub `Create` activity to relevant " +
      "inboxes based on `visibility`. Requires authentication.",
    inputFields: (t) => ({
      visibility: t.field({
        type: PostVisibility,
        required: true,
        description: "Audience for the new Question post.",
      }),
      content: t.field({
        type: "Markdown",
        required: true,
        description:
          "Markdown body shown above the poll. The body remains editable " +
          "only through future note-editing support; poll settings are " +
          "immutable.",
      }),
      language: t.field({
        type: "Locale",
        required: true,
        description: "BCP 47 language tag for the Question body.",
      }),
      quotePolicy: t.field({
        type: QuotePolicy,
        required: false,
        description:
          "Who may quote this Question. Omit to use the default policy for " +
          "the selected `visibility`.",
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to publish as. Omit to publish as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to publish as that " +
          "organization.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the personal member when `actingAccountId` is " +
          "an organization. Defaults to `ACTING_ACCOUNT_ONLY`; invalid " +
          "when publishing as a personal account.",
      }),
      poll: t.field({
        type: CreateQuestionPollInput,
        required: true,
        description:
          "Poll title, options, selection mode, and deadline. These values " +
          "cannot be changed after publishing.",
      }),
      media: t.field({
        type: [CreateNoteMediumInput],
        required: false,
        defaultValue: [],
        description: "Media to attach to the Question body, in display order.",
      }),
      replyTargetId: t.globalID({
        for: [Note, Article, Question],
        required: false,
        description:
          "Optional post to reply to. The target must be visible to the " +
          "authenticated account.",
      }),
      quotedPostId: t.globalID({
        for: [Note, Article, Question],
        required: false,
        description:
          "Optional post to quote. Share wrappers are resolved to their " +
          "original post before quote policy checks.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const authenticatedAccountId = ctx.account.id;
      const {
        visibility,
        content,
        language,
        quotePolicy,
        poll,
        media,
        replyTargetId,
        quotedPostId,
      } = args.input;
      const actingAccount = await resolvePostActingAccount(ctx, args.input);
      const attachedMedia = media ?? [];
      if (attachedMedia.length > 20) {
        throw new InvalidInputError("media");
      }
      if (visibility === "NONE") {
        throw new InvalidInputError("visibility");
      }
      let replyTarget: (schema.Post & { actor: schema.Actor }) | undefined;
      if (replyTargetId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: replyTargetId.id },
        });
        if (post == null) {
          throw new InvalidInputError("replyTargetId");
        }
        const effectivePost = post.sharedPost ?? post;
        if (
          !isPostVisibleTo(post, actingAccount.account.actor) ||
          !isPostVisibleTo(effectivePost, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("replyTargetId");
        }
        replyTarget = post;
      }
      let quotedPost: (schema.Post & { actor: schema.Actor }) | undefined;
      if (quotedPostId != null) {
        const post = await ctx.db.query.postTable.findFirst({
          with: {
            actor: {
              with: {
                followers: {
                  where: { followerId: actingAccount.account.actor.id },
                },
                blockees: {
                  where: { blockeeId: actingAccount.account.actor.id },
                },
                blockers: {
                  where: { blockerId: actingAccount.account.actor.id },
                },
              },
            },
            mentions: { where: { actorId: actingAccount.account.actor.id } },
            sharedPost: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: { followerId: actingAccount.account.actor.id },
                    },
                    blockees: {
                      where: { blockeeId: actingAccount.account.actor.id },
                    },
                    blockers: {
                      where: { blockerId: actingAccount.account.actor.id },
                    },
                  },
                },
                mentions: {
                  where: { actorId: actingAccount.account.actor.id },
                },
              },
            },
          },
          where: { id: quotedPostId.id },
        });
        if (
          post == null ||
          !isPostVisibleTo(post, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        const effectivePost = post.sharedPost ?? post;
        if (effectivePost.sharedPostId != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (!isPostVisibleTo(effectivePost, actingAccount.account.actor)) {
          throw new InvalidInputError("quotedPostId");
        }
        // Neither a censored post nor a censored share wrapper can be
        // quoted; the model revalidates, but the submitted row is
        // unwrapped here, so the wrapper must be checked here too.
        if (post.censored != null || effectivePost.censored != null) {
          throw new InvalidInputError("quotedPostId");
        }
        if (
          !canActorRequestQuotePost(effectivePost, actingAccount.account.actor)
        ) {
          throw new InvalidInputError("quotedPostId");
        }
        quotedPost = effectivePost;
      }
      return await withTransaction(ctx.fedCtx, async (context) => {
        const noteMedia = await Promise.all(
          attachedMedia.map(async (medium, i) => {
            const alt = medium.alt.trim();
            if (alt === "") throw new InvalidInputError(`media.${i}.alt`);
            const storedMedium = await context.db.query.mediumTable.findFirst({
              where: { id: medium.mediumId },
            });
            if (storedMedium == null) {
              throw new InvalidInputError(`media.${i}.mediumId`);
            }
            return { mediumId: medium.mediumId, alt };
          }),
        );
        const modelVisibility =
          visibility === "PUBLIC"
            ? "public"
            : visibility === "UNLISTED"
              ? "unlisted"
              : visibility === "FOLLOWERS"
                ? "followers"
                : visibility === "DIRECT"
                  ? "direct"
                  : visibility === "NONE"
                    ? "none"
                    : assertNever(
                        visibility,
                        `Unknown value in Post.visibility: "${visibility}"`,
                      );
        let question: Awaited<ReturnType<typeof createQuestion>>;
        await assertActingAccountNotSuspended(
          ctx.db,
          authenticatedAccountId,
          actingAccount.account.id,
        );
        try {
          question = await createQuestion(
            context,
            {
              accountId: actingAccount.account.id,
              visibility: modelVisibility,
              quotePolicy: normalizeQuotePolicyForVisibility(
                modelVisibility,
                quotePolicy == null ? undefined : fromQuotePolicy(quotePolicy),
              ),
              content,
              language: language.baseName,
              media: noteMedia,
              poll: {
                title: poll.title,
                multiple: poll.multiple,
                options: poll.options,
                ends: poll.ends,
              },
            },
            { replyTarget, quotedPost },
            {
              afterPostCreated: (post, db) =>
                recordPostActingAccount(db, post.id, actingAccount),
            },
          );
        } catch (error) {
          if (error instanceof QuotePolicyDeniedError) {
            throw new InvalidInputError("quotedPostId");
          }
          if (error instanceof InvalidPollInputError) {
            throw new InvalidInputError(error.inputPath);
          }
          throw error;
        }
        if (question == null) {
          throw createGraphQLError("Failed to create question.", {
            originalError: new Error("Failed to create question."),
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        }
        return question;
      });
    },
  },
  {
    outputFields: (t) => ({
      question: t.field({
        type: Question,
        description: "The newly published `Question` post.",
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "updateNote",
  {
    description:
      "Edit the content, language, or quote policy of an existing local " +
      "note. Visibility cannot be changed after creation. Only the note's " +
      "author may call this. Pass `actingAccountId` when editing a note " +
      "authored by an organization account you belong to. Sends an " +
      "ActivityPub `Update` activity to the appropriate recipients. " +
      "Requires authentication.",
    inputFields: (t) => ({
      noteId: t.globalID({
        for: [Note],
        required: true,
        description: "Global ID of the note to update.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
      content: t.field({
        type: "Markdown",
        required: false,
        description: "New Markdown body. Omit to keep the existing content.",
      }),
      language: t.field({
        type: "Locale",
        required: false,
        description: "New language. Omit to keep the existing language.",
      }),
      quotePolicy: t.field({
        type: QuotePolicy,
        required: false,
        description: "New quote policy. Omit to keep the existing policy.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: args.input.noteId.id },
        with: { noteSource: true },
      });
      if (post?.noteSource == null) throw new InvalidInputError("noteId");
      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.noteSource.accountId,
        "noteId",
      );

      const patch = {
        ...(args.input.content != null ? { content: args.input.content } : {}),
        ...(args.input.language != null
          ? { language: args.input.language.baseName }
          : {}),
        ...(args.input.quotePolicy != null
          ? { quotePolicy: fromQuotePolicy(args.input.quotePolicy) }
          : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw new InvalidInputError("input");
      }
      const updated = await updateNote(ctx.fedCtx, post.noteSource.id, patch);
      if (updated == null) throw new InvalidInputError("noteId");
      return updated;
    },
  },
  {
    outputFields: (t) => ({
      note: t.field({
        type: Note,
        description: "The note after the update has been applied.",
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "saveArticleDraft",
  {
    description:
      "Create or update an article draft. Omit `id` and `uuid` to create a " +
      "new draft (a UUID is generated). Pass `actingAccountId` to create it " +
      "in an organization workspace you can post for; it defaults to your " +
      "personal account, and once created the owning workspace can only be " +
      "changed with `moveArticleDraftToOrganization`. Pass the draft's " +
      "`revision` on an update so a concurrent edit returns " +
      "`ArticleDraftConflictError` instead of being overwritten; omitting it " +
      "writes unconditionally, a transition escape hatch for clients built " +
      "before revision-based checks. Requires authentication.",
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: false }),
      uuid: t.field({
        type: "UUID",
        required: false,
        description: "Draft UUID to use when creating a new draft.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description:
          "Workspace `Account` to create the draft in: your personal " +
          "account or an organization you can post for. Only used when " +
          "creating; when updating it must match the stored owner.",
      }),
      title: t.string({ required: true }),
      content: t.field({ type: "Markdown", required: true }),
      language: t.field({
        type: "Locale",
        required: false,
        description:
          "Original language of the draft. Record it early so translation " +
          "drafts can be added before publication; once translations exist " +
          "the language can no longer be changed. Omit it to leave the stored " +
          "language unchanged (a legacy draft keeps `null` until a save sets " +
          "it). It must be one of the supported content locales.",
      }),
      tags: t.stringList({ required: true }),
      revision: t.int({
        required: false,
        description:
          "The `ArticleDraft.revision` the client is editing from. With `id`, " +
          "a matching revision updates the draft and a stale one returns " +
          "`ArticleDraftConflictError`; omitting it writes unconditionally. " +
          "With `uuid` and a revision the call updates an existing draft and " +
          "fails if it is missing. With `uuid` and no revision the call " +
          "creates the draft or updates it if it already exists (the " +
          "pre-upgrade composer's path). Supplying `revision` without an " +
          "identifier is invalid.",
      }),
    }),
  },
  {
    description:
      "Create or update an article draft. Omit `id` and `uuid` to create a " +
      "new draft. Pass `actingAccountId` to create it in an organization " +
      "workspace you can post for, and `revision` to reject a concurrent " +
      "edit with `ArticleDraftConflictError`. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const {
        id,
        uuid,
        actingAccountId,
        title,
        content,
        language,
        tags,
        revision,
      } = args.input;
      if (actingAccountId != null) {
        if (
          actingAccountId.typename != null &&
          actingAccountId.typename !== "Account"
        ) {
          throw new InvalidInputError("actingAccountId");
        }
        if (!validateUuid(actingAccountId.id)) {
          throw new InvalidInputError("actingAccountId");
        }
      }
      const result = await saveArticleDraft(ctx.db, ctx.account, {
        id: id?.id,
        uuid,
        actingAccountId: actingAccountId?.id,
        title,
        content,
        language: language?.baseName ?? null,
        tags,
        revision,
      });
      switch (result.status) {
        case "ok":
          return result.draft;
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      draft: t.field({
        type: ArticleDraft,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deleteArticleDraft",
  {
    description:
      "Permanently delete an article draft. The draft's owner (or an " +
      "accepted member of its owning organization) may delete it. Pass " +
      "`revision` to delete only the exact version the client saw. " +
      "Requires authentication.",
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: true }),
      revision: t.int({
        required: false,
        description:
          "Optional `ArticleDraft.revision`. When given, the delete is " +
          "rejected with `ArticleDraftConflictError` if the draft changed.",
      }),
    }),
  },
  {
    description:
      "Permanently delete an article draft. The draft's owner or an accepted " +
      "member of its owning organization may delete it, and an optional " +
      "`revision` guards against deleting a newer version. Requires " +
      "authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const result = await deleteArticleDraft(ctx.db, ctx.account, {
        id: args.input.id.id,
        revision: args.input.revision,
      });
      switch (result.status) {
        case "ok":
          return { deletedDraftId: result.draftId };
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "invalid":
          throw new InvalidInputError("id");
      }
    },
  },
  {
    outputFields: (t) => ({
      deletedDraftId: t.globalID({
        resolve(result) {
          return { type: "ArticleDraft", id: result.deletedDraftId };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "moveArticleDraftToOrganization",
  {
    description:
      "Move a personally owned article draft to an organization you can post " +
      "for, so its accepted members gain access and it publishes as the " +
      "organization. The draft's creator record and attached media are " +
      "preserved. Organization-to-personal and organization-to-organization " +
      "moves are not supported. Requires authentication.",
    inputFields: (t) => ({
      id: t.globalID({
        for: [ArticleDraft],
        required: true,
        description: "Global ID of the personally owned draft to move.",
      }),
      organizationAccountId: t.globalID({
        for: [Account],
        required: true,
        description: "Organization `Account` to move the draft to.",
      }),
      revision: t.int({
        required: true,
        description: "The `ArticleDraft.revision` the client is editing from.",
      }),
    }),
  },
  {
    description:
      "Move a personally owned article draft to an organization you can post " +
      "for, so its accepted members gain access and it publishes as the " +
      "organization. The draft's creator record and attached media are " +
      "preserved. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const destination = args.input.organizationAccountId;
      if (destination.typename != null && destination.typename !== "Account") {
        throw new InvalidInputError("organizationAccountId");
      }
      if (!validateUuid(destination.id)) {
        throw new InvalidInputError("organizationAccountId");
      }
      const result = await moveArticleDraftToOrganization(ctx.db, ctx.account, {
        id: args.input.id.id,
        organizationAccountId: destination.id,
        revision: args.input.revision,
      });
      switch (result.status) {
        case "ok":
          return result.draft;
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      draft: t.field({
        type: ArticleDraft,
        description:
          "The moved draft, now owned by the destination organization with " +
          "its `revision` incremented and `creator` unchanged.",
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deletePost",
  {
    description:
      "Delete a post and send an ActivityPub `Delete` activity to " +
      "federated instances. Boost wrappers cannot be deleted this way; " +
      "use `unsharePost` instead (returns `SharedPostDeletionNotAllowedError`). " +
      "Pass `actingAccountId` to delete a post authored by an organization " +
      "account you belong to.",
    inputFields: (t) => ({
      id: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to delete.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        SharedPostDeletionNotAllowedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: { actor: true, replyTarget: true },
        where: { id: args.input.id.id },
      });

      if (post == null || post.actor.accountId == null) {
        throw new InvalidInputError("id");
      }
      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.actor.accountId,
        "id",
      );

      if (post.sharedPostId != null) {
        throw new SharedPostDeletionNotAllowedError("id");
      }

      await deletePost(ctx.fedCtx, post);

      return { deletedPostId: args.input.id };
    },
  },
  {
    outputFields: (t) => ({
      deletedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.deletedPostId.typename,
            id: result.deletedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "revokeQuote",
  {
    description:
      "As the quoted post's author, revoke permission for a quote of " +
      "your post. Sends a revocation activity to the quoting instance. " +
      "Only the `quotedPost`'s author may call this. Pass `actingAccountId` " +
      "when the quoted post was authored by an organization account you " +
      "belong to.",
    inputFields: (t) => ({
      quotePostId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the quote post to revoke.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );
      const quote = await ctx.db.query.postTable.findFirst({
        with: {
          actor: true,
          quotedPost: true,
        },
        where: { id: args.input.quotePostId.id },
      });
      if (quote?.quotedPost == null) {
        throw new InvalidInputError("quotePostId");
      }
      if (quote.quotedPost.actorId !== actingAccount.actor.id) {
        throw new InvalidInputError("quotePostId");
      }
      if (
        quote.actor.accountId == null &&
        quote.quoteAuthorizationIri == null
      ) {
        throw new InvalidInputError("quotePostId");
      }
      const updatedQuote = await withTransaction(
        ctx.fedCtx,
        async (context) =>
          await revokeQuoteModel(
            context,
            actingAccount,
            quote,
            quote.quotedPost!,
          ),
      );
      const quotedPost = await ctx.db.query.postTable.findFirst({
        where: { id: quote.quotedPost.id },
      });
      if (quotedPost == null) throw new InvalidInputError("quotePostId");
      return { quote: updatedQuote, quotedPost };
    },
  },
  {
    outputFields: (t) => ({
      quote: t.field({
        type: Post,
        resolve(result) {
          return result.quote;
        },
      }),
      quotedPost: t.field({
        type: Post,
        resolve(result) {
          return result.quotedPost;
        },
      }),
    }),
  },
);

const PublishArticleTranslationSelection = builder.inputType(
  "PublishArticleTranslationSelection",
  {
    description:
      "One private translation draft selected for initial publication. The " +
      "`revision` is checked inside the publication transaction so a " +
      "translation another member saved after the checklist loaded makes the " +
      "whole publication fail instead of publishing unreviewed text.",
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      revision: t.int({ required: true }),
    }),
  },
);

builder.relayMutationField(
  "publishArticleDraft",
  {
    description:
      "Publish an article draft, converting it to a live `Article` post and " +
      "deleting the draft. The article is published as the draft's owning " +
      "workspace account (personal or organization), which therefore must be " +
      "an account the viewer can post for. For an organization draft, " +
      "`attributionMode` and `attributionAccountId` choose which personal " +
      "member is credited as co-author (defaulting to the draft's creator). " +
      "Pass the draft's current `revision` to reject a concurrent edit with " +
      "`ArticleDraftConflictError`; omitting it publishes the current content. " +
      "Sends an ActivityPub `Create` activity. Requires authentication.",
    inputFields: (t) => ({
      id: t.globalID({ for: [ArticleDraft], required: true }),
      slug: t.string({ required: true }),
      language: t.field({ type: "Locale", required: true }),
      allowLlmTranslation: t.boolean({ required: false }),
      quotePolicy: t.field({ type: QuotePolicy, required: false }),
      translations: t.field({
        type: [PublishArticleTranslationSelection],
        required: false,
        description:
          "Private translation drafts to publish together with the original, " +
          "each with the exact revision the publisher reviewed. Unlisted " +
          "translation drafts stay private under the published article. Any " +
          "stale revision, foreign draft, empty translation, or duplicate " +
          "language aborts the whole publication without partial writes.",
      }),
      revision: t.int({
        required: false,
        description:
          "The `ArticleDraft.revision` being published. When provided, a " +
          "stale value returns `ArticleDraftConflictError` so a concurrent " +
          "edit is not lost. Omit it to publish whatever is currently " +
          "stored; this is a transition escape hatch for clients built " +
          "before revision-based conflict checks and will be required in a " +
          "later release.",
      }),
      attributionMode: t.field({
        type: PostAttributionMode,
        required: false,
        description:
          "How to display the credited personal member when the draft is " +
          "owned by an organization. Defaults to `ACTING_ACCOUNT_ONLY`; " +
          "invalid when the draft is personally owned.",
      }),
      attributionAccountId: t.globalID({
        for: [Account],
        required: false,
        description:
          "Personal member `Account` to credit as co-author of an " +
          "organization draft. Defaults to the draft's creator when the " +
          "creator is still an accepted member, otherwise the publisher. " +
          "Must be an accepted member of the owning organization, and is " +
          "invalid together with `ACTING_ACCOUNT_ONLY` or a personal draft.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        deprecationReason:
          "Use `moveArticleDraftToOrganization` to publish a draft as an " +
          "organization. This argument only keeps pre-upgrade clients " +
          "working during the rollout.",
        description:
          "Deprecated organization-publishing argument, kept for " +
          "compatibility during the rollout. For a personally owned draft it " +
          "behaves as before and publishes the article as that organization, " +
          "which the viewer must be able to post for; new clients should " +
          "move the draft with `moveArticleDraftToOrganization` instead. For " +
          "an organization draft it must equal the draft's owning account.",
      }),
    }),
  },
  {
    description:
      "Publish an article draft as its owning workspace account, deleting the " +
      "draft and sending an ActivityPub `Create` activity. An optional " +
      "`revision` rejects a concurrent edit, and `attributionMode` with " +
      "`attributionAccountId` choose the credited co-author for an " +
      "organization draft. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const publisher = ctx.account;
      const { slug, language, allowLlmTranslation, quotePolicy, revision } =
        args.input;
      for (const arg of [
        args.input.actingAccountId,
        args.input.attributionAccountId,
      ]) {
        if (arg == null) continue;
        if (arg.typename != null && arg.typename !== "Account") {
          throw new InvalidInputError(
            arg === args.input.actingAccountId
              ? "actingAccountId"
              : "attributionAccountId",
          );
        }
        if (!validateUuid(arg.id)) {
          throw new InvalidInputError(
            arg === args.input.actingAccountId
              ? "actingAccountId"
              : "attributionAccountId",
          );
        }
      }
      const attributionAccountId = args.input.attributionAccountId?.id ?? null;
      // Canonicalize the publication language with the same policy translation
      // drafts use, so a `zh-Hans` publication is recognized as the same
      // language as a `zh-CN` draft and cannot produce a same-language pair.
      const publicationLanguage =
        normalizeContentLanguage(language.baseName) ?? language.baseName;

      type PublishOutcome =
        | { kind: "error"; inputPath: string }
        | { kind: "conflict"; currentRevision: number }
        | { kind: "failed" }
        | {
            kind: "ok";
            article: NonNullable<Awaited<ReturnType<typeof createArticle>>>;
            deletedDraftId: Uuid;
          };

      const outcome = await withTransaction<PublishOutcome>(
        ctx.fedCtx,
        async (context): Promise<PublishOutcome> => {
          const draftRows = await context.db
            .select()
            .from(articleDraftTable)
            .where(eq(articleDraftTable.id, args.input.id.id))
            .for("update");
          const draft = draftRows[0];
          if (draft == null) return { kind: "error", inputPath: "id" };
          if (
            !(await canAccountActAs(context.db, publisher, draft.accountId))
          ) {
            return { kind: "error", inputPath: "id" };
          }
          if (draft.articleSourceId != null) {
            return { kind: "error", inputPath: "id" };
          }
          if (revision != null && revision !== draft.revision) {
            return { kind: "conflict", currentRevision: draft.revision };
          }
          // Validate every selected translation before any write. A stale
          // revision, a foreign draft, an empty translation, or a duplicate or
          // original language aborts the whole publication so no partial
          // subset can escape.
          const selectedTranslationDrafts: schema.ArticleTranslationDraft[] =
            [];
          const seenLanguages = new Set<string>();
          // Lock the selections in a stable id order, after the owning draft
          // lock, matching the owner -> translation draft order every other
          // path uses. Without the lock a concurrent save could land between
          // validation and the copy below, publishing text nobody selected.
          const selections = [...(args.input.translations ?? [])].sort(
            (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
          for (const selection of selections) {
            const lockedRows = await context.db
              .select()
              .from(articleTranslationDraftTable)
              .where(eq(articleTranslationDraftTable.id, selection.id))
              .for("update");
            const translationDraft = lockedRows[0];
            if (
              translationDraft == null ||
              translationDraft.articleDraftId !== draft.id ||
              translationDraft.revision !== selection.revision ||
              translationDraft.language === publicationLanguage ||
              translationDraft.title.trim() === "" ||
              translationDraft.content.trim() === "" ||
              seenLanguages.has(translationDraft.language)
            ) {
              return { kind: "error", inputPath: "translations" };
            }
            seenLanguages.add(translationDraft.language);
            selectedTranslationDrafts.push(translationDraft);
          }
          // The original language must not collide with any surviving
          // translation draft, selected or not: promotion keeps unselected
          // drafts under the published article, and a same-language draft
          // could never be published afterwards.
          const draftLanguages =
            await context.db.query.articleTranslationDraftTable.findMany({
              where: { articleDraftId: draft.id },
              columns: { language: true },
            });
          if (
            draftLanguages.some(
              (translationDraft) =>
                translationDraft.language === publicationLanguage,
            )
          ) {
            return { kind: "error", inputPath: "language" };
          }
          // The draft's owner is the publishing account by default. The
          // deprecated `actingAccountId` keeps the pre-revision flow: a
          // personally owned draft may still be published as an organization
          // the viewer can post for, without moving the draft first.
          let workspaceId = draft.accountId;
          const requestedActingAccountId =
            args.input.actingAccountId?.id ?? null;
          if (
            requestedActingAccountId != null &&
            requestedActingAccountId !== draft.accountId
          ) {
            if (draft.accountId !== publisher.id) {
              return { kind: "error", inputPath: "actingAccountId" };
            }
            const requested = await context.db.query.accountTable.findFirst({
              where: { id: requestedActingAccountId },
              columns: { kind: true },
            });
            if (requested?.kind !== "organization") {
              return { kind: "error", inputPath: "actingAccountId" };
            }
            if (
              !(await canAccountActAs(
                context.db,
                publisher,
                requestedActingAccountId,
              ))
            ) {
              return { kind: "error", inputPath: "actingAccountId" };
            }
            workspaceId = requestedActingAccountId;
          }
          const workspace = await context.db.query.accountTable.findFirst({
            where: { id: workspaceId },
            with: { actor: true },
          });
          if (workspace == null || workspace.actor == null) {
            return { kind: "error", inputPath: "id" };
          }
          let attributionMode:
            | "acting_account_only"
            | "acting_account_with_viewer"
            | null = null;
          let memberAccountId = publisher.id;
          if (workspace.kind === "personal") {
            if (
              args.input.attributionMode != null ||
              attributionAccountId != null
            ) {
              return { kind: "error", inputPath: "attributionMode" };
            }
          } else {
            attributionMode =
              args.input.attributionMode ?? "acting_account_only";
            if (
              attributionMode === "acting_account_only" &&
              attributionAccountId != null
            ) {
              return { kind: "error", inputPath: "attributionAccountId" };
            }
            // Record the credited member independently of whether it is
            // displayed: the `member` resolver hides it for
            // `ACTING_ACCOUNT_ONLY`, but the draft creator should not be
            // forgotten once the draft is deleted.
            const candidate =
              attributionAccountId ?? draft.creatorId ?? publisher.id;
            if (candidate === workspace.id) {
              // The publishing organization cannot be its own co-author.
              return { kind: "error", inputPath: "attributionAccountId" };
            }
            const accepted = await canAccountActAs(
              context.db,
              { id: candidate, kind: "personal" },
              workspace.id,
            );
            if (!accepted) {
              if (attributionAccountId != null) {
                return { kind: "error", inputPath: "attributionAccountId" };
              }
              memberAccountId = publisher.id;
            } else {
              memberAccountId = candidate;
            }
          }
          await assertActingAccountNotSuspended(
            context.db,
            publisher.id,
            workspace.id,
          );
          const media = await context.db.query.articleDraftMediumTable.findMany(
            { where: { articleDraftId: draft.id } },
          );
          const additionalContents: ArticleAdditionalContent[] = [];
          for (const translationDraft of selectedTranslationDrafts) {
            const translationMedia =
              await context.db.query.articleTranslationDraftMediumTable.findMany(
                {
                  where: {
                    articleTranslationDraftId: translationDraft.id,
                  },
                },
              );
            additionalContents.push({
              language: translationDraft.language,
              title: translationDraft.title,
              content: translationDraft.content,
              originalLanguage: publicationLanguage,
              translatorId: translationDraft.translatorId,
              provenance:
                translationDraft.provenance === "llm"
                  ? "llm_reviewed"
                  : translationDraft.provenance === "unknown"
                    ? "unknown"
                    : "human",
              sourceRevisionId: translationDraft.sourceRevisionId,
              // Only genuine pre-publication review evidence travels with the
              // translation; the publisher never becomes its reviewer just by
              // publishing it.
              reviewerId: translationDraft.reviewerId,
              reviewed: translationDraft.reviewed,
              // Include the parent draft's attachments too: a translation may
              // reference an original image that the original body no longer
              // does, and the parent draft is deleted at publication.
              media: [
                ...translationMedia.map((m) => ({
                  key: m.key,
                  mediumId: m.mediumId,
                })),
                ...media.map((m) => ({ key: m.key, mediumId: m.mediumId })),
              ],
            });
          }
          const resolved: ResolvedPostActingAccount = {
            account: workspace,
            memberAccountId,
            publisherAccountId: publisher.id,
            attributionMode,
          };
          // Reuse the draft's current snapshot as the published original's
          // revision only when it actually matches the published title, body
          // and language, so a translation baselined on it is not immediately
          // considered stale (and a language change at publish time records a
          // fresh snapshot under the right language).
          const draftRevision = await getCurrentDraftRevision(
            context.db,
            draft.id,
          );
          const reusableRevision =
            draftRevision != null &&
            draftRevision.language === publicationLanguage &&
            draftRevision.title === draft.title &&
            draftRevision.content === draft.content
              ? draftRevision.id
              : undefined;
          const created = await createArticle(
            context,
            {
              accountId: workspace.id,
              publishedYear: new Date().getFullYear(),
              slug,
              tags: draft.tags,
              allowLlmTranslation: allowLlmTranslation ?? true,
              quotePolicy:
                quotePolicy == null ? "everyone" : fromQuotePolicy(quotePolicy),
              title: draft.title,
              content: draft.content,
              language: publicationLanguage,
              media,
              additionalContents,
              originalRevisionId: reusableRevision,
            },
            {
              afterPostCreated: (post, db) =>
                recordPostActingAccount(db, post.id, resolved),
            },
          );
          if (created == null) return { kind: "failed" };
          // Re-point every translation draft and revision (selected or not) to
          // the new source before deleting the original draft, so unselected
          // drafts survive and keep their UUIDs, revisions, and media.
          await promoteArticleTranslationDrafts(
            context.db,
            draft.id,
            created.articleSource.id,
            selectedTranslationDrafts.map((translationDraft) => ({
              id: translationDraft.id,
              revision: translationDraft.revision,
            })),
          );
          await context.db
            .delete(articleDraftTable)
            .where(eq(articleDraftTable.id, draft.id));
          return {
            kind: "ok",
            article: created,
            deletedDraftId: draft.id,
          };
        },
      );

      switch (outcome.kind) {
        case "error":
          throw new InvalidInputError(outcome.inputPath);
        case "conflict":
          throw new ArticleDraftConflictError(outcome.currentRevision);
        case "failed":
          throw createGraphQLError("Failed to publish article.", {
            originalError: new Error("Failed to publish article."),
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        case "ok":
          return {
            article: outcome.article,
            deletedDraftId: outcome.deletedDraftId,
          };
      }
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve(result) {
          return result.article;
        },
      }),
      deletedDraftId: t.globalID({
        resolve(result) {
          return { type: "ArticleDraft", id: result.deletedDraftId };
        },
      }),
    }),
  },
);

builder.drizzleObjectField(Reaction, "post", (t) =>
  t.relation("post", { type: Post }),
);

builder.relayMutationField(
  "saveArticleTranslationDraft",
  {
    description:
      "Create or update a private translation draft attached to an article " +
      "draft (`articleDraftId`) or a published article (`sourceId`). Omit the " +
      "identifier to create one for a language; if that language already has a " +
      "draft, the existing draft is returned unchanged instead of creating a " +
      "duplicate. The credited translator defaults to the original's author " +
      "(personal) or the authenticated individual (organization) and is not " +
      "changed by an editor's save. Pass `revision` on update to reject a " +
      "concurrent edit with `ArticleDraftConflictError`. Requires " +
      "authentication.",
    inputFields: (t) => ({
      id: t.field({ type: "UUID", required: false }),
      uuid: t.field({ type: "UUID", required: false }),
      articleDraftId: t.field({ type: "UUID", required: false }),
      sourceId: t.field({ type: "UUID", required: false }),
      language: t.field({ type: "Locale", required: true }),
      title: t.field({ type: "String", required: true }),
      content: t.field({ type: "Markdown", required: true }),
      translatorId: t.field({ type: "UUID", required: false }),
      provenance: t.field({
        type: ArticleTranslationProvenance,
        required: false,
        description:
          "Where the starting text came from. Fixed at creation; omitting it " +
          "defaults to `HUMAN`. `LLM` is accepted only when the language " +
          "already has a completed automatic or AI-reviewed version to seed " +
          "from.",
      }),
      revision: t.int({ required: false }),
    }),
  },
  {
    description:
      "Create or update a private translation draft, returning it and the " +
      "existing draft for its language when one is already present. Requires " +
      "authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const result = await saveArticleTranslationDraft(ctx.db, ctx.account, {
        id: args.input.id,
        uuid: args.input.uuid,
        articleDraftId: args.input.articleDraftId,
        sourceId: args.input.sourceId,
        language: args.input.language.baseName,
        title: args.input.title,
        content: args.input.content,
        translatorId: args.input.translatorId ?? undefined,
        provenance: args.input.provenance ?? undefined,
        revision: args.input.revision,
      });
      switch (result.status) {
        case "ok":
          return result.draft;
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      draft: t.field({
        type: ArticleTranslationDraft,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deleteArticleTranslationDraft",
  {
    description:
      "Delete a private translation draft. This never removes an already " +
      "published translation: the public version stays until it is explicitly " +
      "replaced or withdrawn. Requires authentication.",
    inputFields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      revision: t.int({ required: false }),
    }),
  },
  {
    description:
      "Delete a private translation draft without touching any published " +
      "version. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const result = await deleteArticleTranslationDraft(ctx.db, ctx.account, {
        id: args.input.id,
        revision: args.input.revision,
      });
      switch (result.status) {
        case "ok":
          return { deletedDraftId: result.draftId };
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError("id");
      }
    },
  },
  {
    outputFields: (t) => ({
      deletedDraftId: t.field({
        type: "UUID",
        resolve(result) {
          return result.deletedDraftId;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "acknowledgeArticleTranslationSource",
  {
    description:
      "Record that an authorized editor compared a translation against a " +
      "specific source revision and decided it needs no change, for example " +
      "after a typo fix in the original. It moves the reviewed baseline " +
      "without touching the translated text or the public translator credit, " +
      "and it credits the acknowledging individual as the version's " +
      "reviewer, which is separate from that credit.\n\nThe revision must " +
      "be named explicitly: an acknowledgement speaks only for the revision " +
      "that was actually read. If the original moved while the comparison " +
      "was open, passing the older revision leaves the translation in " +
      "`NEEDS_REVIEW`, which is intended. Both the private draft (when the " +
      "language has one) and the published version are advanced, because " +
      "publishing copies the draft's baseline. When the published " +
      "version's baseline actually moves, its public freshness changes, so " +
      "the article's object version advances and an ActivityPub `Update` " +
      "is sent; acknowledging a private draft alone sends nothing. Requires " +
      "authentication and the same authority that governs editing the " +
      "article.",
    inputFields: (t) => ({
      articleDraftId: t.field({
        type: "UUID",
        required: false,
        description:
          "The unpublished `ArticleDraft.uuid` whose translation drafts are " +
          "being reviewed. Pass exactly one of this and `sourceId`.",
      }),
      sourceId: t.field({
        type: "UUID",
        required: false,
        description:
          "The published `Article.sourceId` whose translation is being " +
          "reviewed. Pass exactly one of this and `articleDraftId`.",
      }),
      language: t.field({
        type: "Locale",
        required: true,
        description:
          "The translated language being acknowledged, never the original " +
          "language.",
      }),
      sourceRevisionId: t.field({
        type: "UUID",
        required: true,
        description:
          "The `ArticleSourceRevision.uuid` that was actually compared, " +
          "normally the `currentSourceRevision` the editor rendered.",
      }),
      translationDraftRevision: t.int({
        required: false,
        description:
          "The `ArticleTranslationDraft.revision` being acknowledged, when " +
          "the language has a private draft. A mismatch returns " +
          "`ArticleDraftConflictError` instead of acknowledging text the " +
          "reviewer never saw.",
      }),
    }),
  },
  {
    description:
      "Acknowledge that a translation needs no change for a given source " +
      "revision. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const { articleDraftId, sourceId } = args.input;
      if ((articleDraftId == null) === (sourceId == null)) {
        throw new InvalidInputError(
          articleDraftId == null ? "articleDraftId" : "sourceId",
        );
      }
      const result = await acknowledgeArticleTranslation(
        ctx.fedCtx,
        ctx.account,
        {
          owner:
            articleDraftId == null
              ? { sourceId: sourceId! }
              : { articleDraftId },
          language: args.input.language.baseName,
          sourceRevisionId: args.input.sourceRevisionId,
          translationDraftRevision: args.input.translationDraftRevision,
        },
      );
      switch (result.status) {
        case "ok":
          return {
            translationDraft: result.translationDraft ?? null,
            content: result.content ?? null,
          };
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      translationDraft: t.field({
        type: ArticleTranslationDraft,
        nullable: true,
        description:
          "The private draft whose baseline advanced, or `null` when the " +
          "language has no private draft.",
        resolve: (result) => result.translationDraft,
      }),
      content: t.field({
        type: ArticleContent,
        nullable: true,
        description:
          "The published version whose baseline advanced, or `null` when the " +
          "language has not been published yet.",
        resolve: (result) => result.content,
      }),
    }),
  },
);

builder.relayMutationField(
  "publishArticleTranslation",
  {
    description:
      "Publish one private translation draft into an already-published " +
      "article's public content, replacing the language version that readers " +
      "currently see. The stored revision is checked so a concurrent edit " +
      "returns `ArticleDraftConflictError`. The credited translator, " +
      "provenance and reviewed baseline come from the draft; the original " +
      "post's title, body and summary are untouched. Requires authentication.",
    inputFields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      revision: t.int({
        required: true,
        description: "The `ArticleTranslationDraft.revision` being published.",
      }),
      sourceRevisionId: t.field({
        type: "UUID",
        required: false,
        description:
          "The `ArticleSourceRevision.uuid` the publisher was shown while " +
          "reviewing (normally `Article.currentSourceRevision`). It becomes " +
          "the published version's baseline and records the publisher as its " +
          "reviewer, so a translation published against the current original " +
          "reads as `CURRENT` and one published from a stale editor stays " +
          "`NEEDS_REVIEW`. Omit it only when the article has no snapshot to " +
          "name: the draft's stored baseline is then published unchanged and " +
          "no reviewer evidence is recorded.",
      }),
    }),
  },
  {
    description:
      "Publish a private translation draft to the article's public content " +
      "and send an ActivityPub `Update`. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
        ArticleDraftConflictError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const result = await publishArticleTranslation(ctx.fedCtx, ctx.account, {
        translationDraftId: args.input.id,
        revision: args.input.revision,
        sourceRevisionId: args.input.sourceRevisionId ?? null,
      });
      switch (result.status) {
        case "ok": {
          const post = await ctx.db.query.postTable.findFirst({
            where: { articleSourceId: result.sourceId },
          });
          if (post == null) throw new InvalidInputError("id");
          return { article: post, language: result.language };
        }
        case "conflict":
          throw new ArticleDraftConflictError(result.currentRevision);
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve(result) {
          return result.article;
        },
      }),
      language: t.field({
        type: "Locale",
        resolve(result) {
          return result.language;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "withdrawArticleTranslation",
  {
    description:
      "Withdraw a published, human-managed translation from an article. " +
      "Readers stop seeing that language, and the ActivityPub `Update` sent " +
      "for the article omits both its `contentMap` entry and its " +
      "[FEP-22cd](https://w3id.org/fep/22cd) translation metadata, which " +
      "peers read as a withdrawal; the article itself keeps its identity, " +
      "replies and reactions. The language's private translation draft, if " +
      "any, is kept and becomes unpublished. Automatic translations cannot " +
      "be withdrawn this way (they follow `allowLlmTranslation`), and while " +
      "that setting stays enabled a reader can request an automatic " +
      "translation of the withdrawn language again. Requires authentication " +
      "and the same authority that governs editing the article.",
    inputFields: (t) => ({
      sourceId: t.field({
        type: "UUID",
        required: true,
        description: "The published `Article.sourceId`.",
      }),
      language: t.field({
        type: "Locale",
        required: true,
        description:
          "The translated language to withdraw, never the original language.",
      }),
    }),
  },
  {
    description:
      "Withdraw a published translation from an article and send an " +
      "ActivityPub `Update`. Requires authentication.",
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const result = await withdrawArticleTranslation(ctx.fedCtx, ctx.account, {
        sourceId: args.input.sourceId,
        language: args.input.language.baseName,
      });
      switch (result.status) {
        case "ok": {
          const post = await ctx.db.query.postTable.findFirst({
            where: { articleSourceId: result.sourceId },
          });
          if (post == null) throw new InvalidInputError("sourceId");
          return {
            article: post,
            language: result.language,
            translationDraft: result.translationDraft ?? null,
          };
        }
        case "forbidden":
          throw new OrganizationPermissionError();
        case "invalid":
          throw new InvalidInputError(result.inputPath);
      }
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        description: "The article the translation was withdrawn from.",
        resolve: (result) => result.article,
      }),
      language: t.field({
        type: "Locale",
        description: "The withdrawn language.",
        resolve: (result) => result.language,
      }),
      translationDraft: t.field({
        type: ArticleTranslationDraft,
        nullable: true,
        description:
          "The language's private translation draft, now unpublished, or " +
          "`null` when it has none.",
        resolve: (result) => result.translationDraft,
      }),
    }),
  },
);

builder.relayMutationField(
  "addReactionToPost",
  {
    description:
      "Add an emoji reaction to a post. Sends an ActivityPub `Like` " +
      "or `EmojiReact` activity. Idempotent: adding the same emoji twice " +
      "has no effect. Exactly one of `emoji` or `customEmojiId` must be " +
      "provided. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to react as. Omit to react as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to react as that " +
          "organization.",
      }),
      emoji: t.string({ required: false }),
      customEmojiId: t.globalID({ for: CustomEmoji, required: false }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const authenticatedAccountId = ctx.account.id;
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId, emoji, customEmojiId } = args.input;

      if (emoji == null && customEmojiId == null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && customEmojiId != null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && !isReactionEmoji(emoji)) {
        throw new InvalidInputError("emoji");
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          // Load the boosted post's author so a wrapper of a sanction-hidden
          // actor's post is correctly hidden by isPostVisibleTo (which now
          // fails closed when a wrapper's sharedPost is not loaded).
          sharedPost: { with: { actor: true } },
          mentions: true,
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      await assertActingAccountNotSuspended(
        ctx.db,
        authenticatedAccountId,
        actingAccount.id,
      );

      const reaction = await react(
        ctx.fedCtx,
        actingAccount,
        post,
        (emoji as ReactionEmoji | null) ?? null,
        customEmojiId?.id as Uuid | undefined,
      );

      if (reaction != null) {
        return reaction;
      }

      const existingReaction = await ctx.db.query.reactionTable.findFirst({
        where:
          emoji != null
            ? { postId: post.id, actorId: actingAccount.actor.id, emoji }
            : {
                postId: post.id,
                actorId: actingAccount.actor.id,
                customEmojiId: customEmojiId!.id as Uuid,
              },
      });

      if (existingReaction != null) {
        return existingReaction;
      }

      throw createGraphQLError("Failed to react to the post.", {
        originalError: new Error("Failed to react to the post."),
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      });
    },
  },
  {
    outputFields: (t) => ({
      reaction: t.drizzleField({
        type: Reaction,
        nullable: true,
        resolve(_query, result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "removeReactionFromPost",
  {
    description:
      "Remove an emoji reaction from a post. Sends an ActivityPub `Undo " +
      "Like` activity. Idempotent: removing a reaction that doesn't exist " +
      "returns `success: true`. Exactly one of `emoji` or `customEmojiId` " +
      "must be provided. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to remove the reaction as. Omit to use " +
          "the authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to remove that " +
          "organization's reaction.",
      }),
      emoji: t.string({ required: false }),
      customEmojiId: t.globalID({ for: CustomEmoji, required: false }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId, emoji, customEmojiId } = args.input;

      if (emoji == null && customEmojiId == null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && customEmojiId != null) {
        throw new InvalidInputError("emoji");
      }
      if (emoji != null && !isReactionEmoji(emoji)) {
        throw new InvalidInputError("emoji");
      }

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
          // A boost shows the wrapper id, so undoing a reaction on it must
          // hydrate sharedPost: isPostVisibleTo() fails closed on a wrapper
          // whose boosted post was not loaded.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      await undoReaction(
        ctx.fedCtx,
        actingAccount,
        post,
        (emoji as ReactionEmoji | null) ?? null,
        customEmojiId?.id as Uuid | undefined,
      );

      return { success: true };
    },
  },
  {
    outputFields: (t) => ({
      success: t.boolean({
        resolve() {
          return true;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "sharePost",
  {
    description:
      "Boost (reshare) a post by creating a share wrapper post and " +
      "sending an ActivityPub `Announce` activity. Returns the wrapper " +
      "post as `share` and the original post as `originalPost`. " +
      "Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to boost as. Omit to boost as the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to boost as that " +
          "organization.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        ActorSuspendedError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      const authenticatedAccountId = ctx.account.id;
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
          sharedPost: {
            with: {
              actor: {
                with: {
                  followers: true,
                  blockees: true,
                  blockers: true,
                },
              },
              mentions: true,
            },
          },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      // Validate sharing eligibility against the effective original post.
      // When the submitted post is itself a share wrapper, the sharing rules
      // apply to the original post's visibility, not the wrapper's.
      // Reject nested wrappers (share-of-share chains) outright; only
      // direct originals (sharedPostId == null) are authoritative.
      const effectivePost = post.sharedPost ?? post;
      if (effectivePost.sharedPostId != null) {
        throw new InvalidInputError("postId");
      }
      if (!isPostVisibleTo(effectivePost, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }
      // A censored post cannot be boosted (by anyone, including its
      // author): the wrapper would copy the censored content and
      // federate an `Announce` re-amplifying moderation-hidden content.
      if (post.censored != null || effectivePost.censored != null) {
        throw new InvalidInputError("postId");
      }
      if (
        effectivePost.visibility !== "public" &&
        effectivePost.visibility !== "unlisted" &&
        !(
          effectivePost.visibility === "followers" &&
          effectivePost.actorId === actingAccount.actor.id
        )
      ) {
        throw new InvalidInputError("postId");
      }

      await assertActingAccountNotSuspended(
        ctx.db,
        authenticatedAccountId,
        actingAccount.id,
      );

      const share = await sharePost(ctx.fedCtx, actingAccount, post);

      return {
        share,
        originalPostId: postId.id,
      };
    },
  },
  {
    outputFields: (t) => ({
      share: t.field({
        type: Post,
        resolve(result) {
          return result.share;
        },
      }),
      originalPost: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.originalPostId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unsharePost",
  {
    description:
      "Undo a boost by deleting the share wrapper post and sending an " +
      "ActivityPub `Undo Announce` activity. Pass the original post's " +
      "`id` (not the wrapper's). Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
      actingAccountId: t.globalID({
        for: Account,
        required: false,
        description:
          "Optional `Account` id to undo a boost as. Omit to use the " +
          "authenticated personal account; pass an organization account " +
          "where the viewer is an accepted member to remove that " +
          "organization's boost.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: {
            with: { actor: true },
          },
          mentions: true,
          // Hydrate sharedPost so a boost wrapper passed by id is judged by
          // isPostVisibleTo() instead of failing closed on the unloaded
          // boosted post.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, actingAccount.actor)) {
        throw new InvalidInputError("postId");
      }

      const unshared = await unsharePost(ctx.fedCtx, actingAccount, post);

      if (unshared == null) {
        throw new InvalidInputError("postId");
      }

      return { success: true, originalPostId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      originalPost: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.originalPostId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "bookmarkPost",
  {
    description:
      "Save a post to the viewer's bookmarks. Bookmarks are private and " +
      "not federated. Idempotent. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          // A boost shows the wrapper id, so bookmarking one must hydrate
          // sharedPost: isPostVisibleTo() fails closed on a wrapper whose
          // boosted post was not loaded.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      if (!isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      await createBookmark(ctx.db, ctx.account, post);

      return { postId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unbookmarkPost",
  {
    description:
      "Remove a post from the viewer's bookmarks. Idempotent. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const { postId } = args.input;

      const alreadyBookmarked = (
        await arePostsBookmarkedBy(ctx.db, [postId.id], ctx.account)
      ).has(postId.id);

      const post = await ctx.db.query.postTable.findFirst({
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          // Mirror `bookmarkPost`: a boost wrapper's boosted post must be
          // hydrated so `isPostVisibleTo` does not fail closed on it.
          sharedPost: { with: { actor: true } },
        },
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      // Removing an existing bookmark is always allowed, even if the post has
      // since become invisible to the viewer (they bookmarked it while it was
      // visible). The visibility gate applies only when there is no bookmark
      // to remove, so this mutation cannot be used as an oracle to probe a
      // post the viewer cannot see via its `post` output field
      // (`deleteBookmark` is otherwise a silent no-op).
      if (!alreadyBookmarked && !isPostVisibleTo(post, ctx.account.actor)) {
        throw new InvalidInputError("postId");
      }

      await deleteBookmark(ctx.db, ctx.account, post);

      return { postId: postId.id, unbookmarkedPostId: postId };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        // Nullable and visibility-gated: removing an owned bookmark is
        // allowed even after the post became invisible to the viewer, but
        // the payload must not then re-expose that post's content. Returns
        // `null` when the post is no longer visible; the client can still
        // reconcile its cache from `unbookmarkedPostId`.
        nullable: true,
        async resolve(query, result, _args, ctx) {
          const viewerActorId = ctx.account?.actor.id ?? null;
          if (
            !(await isPostVisibleToViewer(ctx, result.postId, viewerActorId))
          ) {
            return null;
          }
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post ?? null;
        },
      }),
      unbookmarkedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.unbookmarkedPostId.typename,
            id: result.unbookmarkedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "pinPost",
  {
    description:
      "Pin a post to the top of the viewer's profile. Only the post's " +
      "author may pin it. Pass `actingAccountId` to pin an organization " +
      "post to that organization's profile. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to pin.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await pinPostModel(ctx.fedCtx, actingAccount.actor, post);
      if (pin == null) {
        throw new InvalidInputError("postId");
      }

      return { postId: postId.id };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "unpinPost",
  {
    description:
      "Remove a pin from the viewer's profile. Pass `actingAccountId` to " +
      "remove a pin from an organization profile. Requires authentication.",
    inputFields: (t) => ({
      postId: t.globalID({
        for: [Note, Article, Question],
        required: true,
        description: "Global ID of the post to unpin.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );

      const { postId } = args.input;

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: postId.id },
      });

      if (post == null) {
        throw new InvalidInputError("postId");
      }

      const pin = await unpinPostModel(ctx.fedCtx, actingAccount.actor, post);
      if (pin == null) {
        throw new InvalidInputError("postId");
      }

      return { postId: postId.id, unpinnedPostId: postId };
    },
  },
  {
    outputFields: (t) => ({
      post: t.drizzleField({
        type: Post,
        async resolve(query, result, _args, ctx) {
          const post = await ctx.db.query.postTable.findFirst(
            query({ where: { id: result.postId } }),
          );
          return post!;
        },
      }),
      unpinnedPostId: t.globalID({
        resolve(result) {
          return {
            type: result.unpinnedPostId.typename,
            id: result.unpinnedPostId.id,
          };
        },
      }),
    }),
  },
);

builder.queryField("articleDraft", (t) =>
  t.field({
    type: ArticleDraft,
    nullable: true,
    description:
      "Look up an article draft by its global `id` or its `uuid`. Requires " +
      "authentication; returns the draft only when the viewer owns it or is " +
      "an accepted member of its owning organization. Returns `null` for " +
      "missing and inaccessible drafts alike, so it never leaks the " +
      "existence of another workspace's draft.",
    args: {
      id: t.arg.globalID({ for: [ArticleDraft], required: false }),
      uuid: t.arg({ type: "UUID", required: false }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;

      // At least one of id or uuid must be provided
      if (!args.id && !args.uuid) {
        throw createGraphQLError("Either id or uuid must be provided.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Use uuid if provided, otherwise use id
      const draftId = args.uuid ?? args.id!.id;

      return (
        (await getAccessibleArticleDraft(ctx.db, ctx.account, draftId)) ?? null
      );
    },
  }),
);

builder.queryField("postByUrl", (t) =>
  t.field({
    type: Post,
    nullable: true,
    description:
      "Resolve a post by its URL, fetching it from the originating " +
      "instance via ActivityPub if it is not already cached. Requires " +
      "authentication (unauthenticated callers always receive `null`). " +
      "Returns `null` if the post is not found or not visible to the " +
      "selected viewer account. Pass `actingAccountId` when validating a " +
      "quote target for an organization account.",
    args: {
      url: t.arg.string({ required: true }),
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;
      const parsed = parseHttpUrl(args.url.trim());
      if (parsed == null) return null;
      const actingAccount = await resolveActingAccountForGlobalIdArg(ctx, args);
      const viewerActor = actingAccount.actor;
      const looked = await lookupPostByUrl(ctx, parsed);
      if (looked == null) return null;
      const postId = looked.id;
      const withRelations = {
        actor: {
          with: {
            followers: {
              where: { followerId: viewerActor.id },
            },
            blockees: {
              where: { blockeeId: viewerActor.id },
            },
            blockers: {
              where: { blockerId: viewerActor.id },
            },
          },
        },
        mentions: true,
        // A boost URL resolves to the wrapper, so hydrate sharedPost:
        // isPostVisibleTo() fails closed on a wrapper whose boosted post was
        // not loaded (and this keeps a boost of a sanction-hidden author
        // hidden here too).
        sharedPost: { with: { actor: true } },
      } as const;
      const post = await ctx.db.query.postTable.findFirst({
        with: withRelations,
        where: { id: postId },
      });
      if (post == null) return null;
      if (!isPostVisibleTo(post, viewerActor)) return null;
      return post;
    },
  }),
);

builder.queryField("articleByYearAndSlug", (t) =>
  t.drizzleField({
    type: Article,
    nullable: true,
    description:
      "Look up a locally-authored article by the author's handle, " +
      "publication year, and URL slug. This is the resolver for the " +
      "canonical article permalink path `/@{handle}/{year}/{slug}`.",
    args: {
      handle: t.arg.string({ required: true }),
      idOrYear: t.arg.string({ required: true }),
      slug: t.arg.string({ required: true }),
      actingAccountId: t.arg.id({
        required: false,
        description: actingAccountIdArgDescription,
      }),
    },
    async resolve(query, _, args, ctx) {
      if (!/^\d+$/.test(args.idOrYear)) return null;
      const year = parseInt(args.idOrYear, 10);
      if (!Number.isFinite(year)) return null;

      let handle = args.handle;
      if (handle.startsWith("@")) handle = handle.substring(1);
      const split = handle.split("@");

      let actor;
      if (split.length === 2) {
        const [username, host] = split;
        actor = await ctx.db.query.actorTable.findFirst({
          where: {
            username,
            OR: [{ instanceHost: host }, { handleHost: host }],
          },
        });
      } else if (split.length === 1) {
        actor = await ctx.db.query.actorTable.findFirst({
          where: { username: split[0], accountId: { isNotNull: true } },
        });
      }
      if (actor == null) return null;

      // Only local actors have articles with sources
      if (actor.accountId == null) return null;

      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: actor.accountId },
      });
      if (account == null) return null;

      const source = await ctx.db.query.articleSourceTable.findFirst({
        where: {
          accountId: account.id,
          publishedYear: year,
          slug: args.slug,
        },
      });
      if (source == null) return null;

      const viewerActorId = await resolveViewerActorId(ctx, args);
      const viewerActor =
        viewerActorId == null ? null : await getActorById(ctx, viewerActorId);
      const visibility = getPostVisibilityFilter(viewerActor);
      return (
        (await ctx.db.query.postTable.findFirst(
          query({
            where: {
              AND: [
                {
                  type: "Article",
                  actorId: actor.id,
                  articleSourceId: source.id,
                },
                visibility,
              ],
            },
          }),
        )) ?? null
      );
    },
  }),
);

const UpdateArticleMediumInput = builder.inputType("UpdateArticleMediumInput", {
  fields: (t) => ({
    mediumId: t.field({
      type: "UUID",
      required: true,
      description: "UUID of a Medium to make available to the article source.",
    }),
    key: t.string({
      required: false,
      description:
        "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
    }),
  }),
});

builder.relayMutationField(
  "updateArticle",
  {
    description:
      "Edit an existing article's content, title, or tags. Only the " +
      "article's author may update it. Sends an ActivityPub `Update` " +
      "activity. Pass `actingAccountId` when updating an article authored " +
      "by an organization account you belong to. Requires authentication.",
    inputFields: (t) => ({
      articleId: t.globalID({
        for: [Article],
        required: true,
        description: "Global ID of the article to update.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
      title: t.string({ required: false }),
      content: t.field({ type: "Markdown", required: false }),
      tags: t.stringList({ required: false }),
      language: t.field({ type: "Locale", required: false }),
      allowLlmTranslation: t.boolean({ required: false }),
      media: t.field({
        type: [UpdateArticleMediumInput],
        required: false,
        description:
          "Media to make available to hp-medium:KEY references in the updated article markdown.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const articleId = args.input.articleId.id;
      // Find the post and its articleSource
      const post = await ctx.db.query.postTable.findFirst({
        where: { id: articleId },
        with: { articleSource: true },
      });
      if (post == null || post.articleSource == null) {
        throw new InvalidInputError("articleId");
      }

      await resolvePostManagementActingAccount(
        ctx,
        args.input,
        post.articleSource.accountId,
        "articleId",
      );

      const media: { key: string; mediumId: Uuid }[] = [];
      for (const [i, mediumInput] of (args.input.media ?? []).entries()) {
        const medium = await ctx.db.query.mediumTable.findFirst({
          where: { id: mediumInput.mediumId },
        });
        if (medium == null) {
          throw new InvalidInputError(`media.${i}.mediumId`);
        }
        const key = mediumInput.key?.trim() || medium.id;
        if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
          throw new InvalidInputError(`media.${i}.key`);
        }
        media.push({ key, mediumId: medium.id });
      }

      let updated;
      try {
        updated = await updateArticle(
          ctx.fedCtx,
          post.articleSource.id,
          {
            title: args.input.title ?? undefined,
            content: args.input.content ?? undefined,
            tags: args.input.tags ?? undefined,
            language: args.input.language?.baseName ?? undefined,
            allowLlmTranslation: args.input.allowLlmTranslation ?? undefined,
            media: args.input.media == null ? undefined : media,
          },
          // The authenticated individual, not the acting organization: an
          // editor who is also a credited translator must not notify
          // themselves, while their translation still needs review.
          { editor: { accountId: ctx.account.id } },
        );
      } catch (e) {
        if (e instanceof LanguageChangeWithTranslationsError) {
          throw new InvalidInputError("language");
        }
        throw e;
      }
      if (updated == null) {
        throw new InvalidInputError("articleId");
      }

      return updated;
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "requestArticleTranslation",
  {
    description:
      "Request an LLM translation of an article into the given target " +
      "language. Returns immediately; the translated `ArticleContent` " +
      "appears asynchronously (check `beingTranslated`). Returns " +
      "`LlmTranslationNotAllowedError` if translation is disabled on " +
      "the article or the target language matches the source language.",
    inputFields: (t) => ({
      articleId: t.globalID({ for: [Article], required: true }),
      targetLanguage: t.field({ type: "Locale", required: true }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        InvalidInputError,
        LlmTranslationNotAllowedError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }

      const post = await ctx.db.query.postTable.findFirst({
        where: { id: args.input.articleId.id },
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          mentions: true,
          articleSource: {
            with: { contents: true },
          },
        },
      });
      if (
        post == null ||
        post.type !== "Article" ||
        post.articleSource == null ||
        !isPostVisibleTo(post, ctx.account.actor)
      ) {
        throw new InvalidInputError("articleId");
      }
      if (!post.articleSource.allowLlmTranslation) {
        throw new LlmTranslationNotAllowedError("DISABLED");
      }
      const original = getOriginalArticleContent(post.articleSource);
      if (original == null) {
        throw new InvalidInputError("articleId");
      }
      // The `Locale` scalar accepts any syntactically valid BCP 47
      // tag, but the `[lang]` route only serves locales that pass
      // `normalizeLocale` (i.e. the `POSSIBLE_LOCALES` whitelist
      // used across the project).  Run the same check here so an
      // API client cannot enqueue a translation for a tag the
      // canonical article URL flow will never display.
      const targetLanguage = normalizeLocale(
        args.input.targetLanguage.baseName,
      );
      if (targetLanguage == null) {
        throw new InvalidInputError("targetLanguage");
      }
      // Reject targets that share the source's *language and script*
      // subtags after maximization (so `en` -> `en-US` and `ko` ->
      // `ko-KR` are blocked because they both maximize to the same
      // `language`+`script` pair, but `zh-CN` -> `zh-TW` is allowed
      // because Simplified vs Traditional script genuinely produces a
      // different translation output).  `Article.contents` negotiates
      // among available locales rather than requiring exact tags, so
      // permitting a same-script variant would create a redundant
      // placeholder row whose canonical URL would negotiate back to
      // the existing source content and leave the newly inserted row
      // unreachable; a different-script variant has its own canonical
      // URL slot in the negotiation result.
      const targetMax = new Intl.Locale(targetLanguage).maximize();
      const originalMax = new Intl.Locale(original.language).maximize();
      if (
        targetMax.language === originalMax.language &&
        targetMax.script === originalMax.script
      ) {
        throw new LlmTranslationNotAllowedError("SAME_LANGUAGE");
      }

      // Skip enqueueing if a *completed* translation for the target
      // locale already exists.  `startArticleContentTranslation` is
      // already idempotent against this case (it returns early without
      // calling the translator), but checking here against the
      // already-fetched `articleSource.contents` lets the resolver
      // avoid the extra DB round-trip and makes the no-op intent
      // explicit at the resolver layer.  In-progress and stale rows
      // are intentionally not short-circuited here so the model layer
      // can re-queue them per its 30-minute staleness window.
      const alreadyTranslated = post.articleSource.contents.some(
        (c) =>
          !c.beingTranslated && normalizeLocale(c.language) === targetLanguage,
      );
      if (!alreadyTranslated) {
        await startArticleContentTranslation(ctx.fedCtx, {
          content: original,
          targetLanguage,
          requester: ctx.account,
        });
      }

      return post;
    },
  },
  {
    outputFields: (t) => ({
      article: t.field({
        type: Article,
        resolve: (post) => post,
      }),
    }),
  },
);

builder.relayMutationField(
  "createMedium",
  {
    description:
      "Import a media object from a remote URL and store it locally. " +
      "Use this instead of the two-step `startMediumUpload` / " +
      "`finishMediumUpload` flow when the image is already accessible " +
      "via URL. Requires authentication.",
    inputFields: (t) => ({
      url: t.field({
        type: "URL",
        required: true,
        description:
          "Image URL to import. Data URLs, HTTP, and HTTPS are supported.",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw new NotAuthenticatedError();
      }
      let medium: schema.Medium | undefined;
      try {
        medium = await createMediumFromUrl(ctx.db, ctx.disk, args.input.url, {
          userAgentUrl: new URL(ctx.fedCtx.canonicalOrigin),
        });
      } catch (error) {
        if (!(error instanceof UnsafeMediumUrlError)) throw error;
      }
      if (medium == null) {
        throw new InvalidInputError("url");
      }
      // Record the importing account as the medium owner during the upload
      // window. Without this, content-hash deduplication can return a row
      // owned by another account, and downstream owner-gated operations
      // (e.g. `attachArticleSourceMedium`) would then reject this user
      // even though they performed the import themselves. Mirrors the
      // ownership marker that `finishMediumUpload` sets.
      await setMediumOwner(ctx.kv, medium.id, session.accountId);
      return medium;
    },
  },
  {
    outputFields: (t) => ({
      medium: t.field({
        type: Medium,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

interface MediumUploadStart {
  uploadId: Uuid;
  uploadUrl: URL;
  method: string;
  headers: { name: string; value: string }[];
  expires: Date;
}

builder.relayMutationField(
  "startMediumUpload",
  {
    description:
      "Step 1 of direct image upload: obtain a pre-signed URL and headers " +
      "for a PUT request. After uploading, call `finishMediumUpload` with " +
      "the returned `uploadId`. Filesystem-backed upload URLs use the " +
      "configured canonical `ORIGIN`, which must be browser-reachable. " +
      "Requires authentication.",
    inputFields: (t) => ({
      contentType: t.field({
        type: "MediaType",
        required: true,
        description: "Original image content type.",
      }),
      contentLength: t.int({
        required: true,
        description: "Exact number of bytes the client will upload.",
      }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      if (
        !SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
          args.input
            .contentType as (typeof SUPPORTED_MEDIUM_IMAGE_TYPES)[number],
        )
      ) {
        throw new InvalidInputError("contentType");
      }
      if (
        args.input.contentLength < 1 ||
        args.input.contentLength > MAX_STREAMING_MEDIUM_IMAGE_SIZE
      ) {
        throw new InvalidInputError("contentLength");
      }
      const upload = await createMediumUploadSession(
        ctx.kv,
        session.accountId,
        args.input.contentType,
        args.input.contentLength,
      );
      let uploadUrl: URL;
      try {
        uploadUrl = new URL(
          await ctx.disk.getSignedUploadUrl(upload.key, {
            contentType: upload.contentType,
            contentSize: upload.contentLength,
            contentLength: upload.contentLength,
            expiresIn: "30mins",
          }),
        );
      } catch {
        uploadUrl = new URL("/medium-uploads", ctx.fedCtx.canonicalOrigin);
        uploadUrl.searchParams.set("uploadId", upload.id);
        uploadUrl.searchParams.set("token", upload.token);
      }
      return {
        uploadId: upload.id,
        uploadUrl,
        method: "PUT",
        headers: [{ name: "Content-Type", value: upload.contentType }],
        expires: new Date(Date.now() + MEDIUM_UPLOAD_TTL_MS),
      } satisfies MediumUploadStart;
    },
  },
  {
    outputFields: (t) => ({
      uploadId: t.field({
        type: "UUID",
        resolve: (result) => result.uploadId,
      }),
      uploadUrl: t.field({
        type: "URL",
        resolve: (result) => result.uploadUrl,
      }),
      method: t.string({ resolve: (result) => result.method }),
      headers: t.field({
        type: [MediumUploadHeader],
        resolve: (result) => result.headers,
      }),
      expires: t.field({
        type: "DateTime",
        resolve: (result) => result.expires,
      }),
    }),
  },
);

builder.relayMutationField(
  "finishMediumUpload",
  {
    description:
      "Step 2 of direct image upload: confirm that the PUT to the " +
      "pre-signed URL from `startMediumUpload` has completed, returning " +
      "the resulting `Medium`. Requires authentication.",
    inputFields: (t) => ({
      uploadId: t.field({ type: "UUID", required: true }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const upload = await getMediumUploadSession(ctx.kv, args.input.uploadId);
      if (upload == null || upload.accountId !== session.accountId) {
        throw new InvalidInputError("uploadId");
      }
      try {
        let metadata: { contentLength: number };
        try {
          metadata = await ctx.disk.getMetaData(upload.key);
        } catch {
          throw new InvalidInputError("uploadId");
        }
        if (
          metadata.contentLength !== upload.contentLength ||
          metadata.contentLength > MAX_STREAMING_MEDIUM_IMAGE_SIZE
        ) {
          throw new InvalidInputError("uploadId");
        }
        let bytes: Uint8Array;
        try {
          bytes = await ctx.disk.getBytes(upload.key);
        } catch {
          throw new InvalidInputError("uploadId");
        }
        if (bytes.byteLength !== upload.contentLength) {
          throw new InvalidInputError("uploadId");
        }
        const medium = await createMediumFromBytes(ctx.db, ctx.disk, bytes, {
          maxSize: MAX_STREAMING_MEDIUM_IMAGE_SIZE,
          contentType: upload.contentType,
        });
        if (medium == null) throw new InvalidInputError("uploadId");
        await setMediumOwner(ctx.kv, medium.id, session.accountId);
        return medium;
      } finally {
        try {
          await ctx.disk.delete(upload.key);
        } catch (error) {
          logger.warn(
            "Failed to delete temporary medium upload {key}: {error}",
            {
              key: upload.key,
              error,
            },
          );
        }
        try {
          await deleteMediumUploadSession(ctx.kv, upload.id);
        } catch (error) {
          logger.warn("Failed to delete medium upload session {id}: {error}", {
            id: upload.id,
            error,
          });
        }
      }
    },
  },
  {
    outputFields: (t) => ({
      medium: t.field({
        type: Medium,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

interface AttachedArticleDraftMedium {
  key: string;
  medium: schema.Medium;
}

builder.relayMutationField(
  "attachArticleDraftMedium",
  {
    description:
      "Associate an uploaded `Medium` with an article draft so it can be " +
      "referenced in the draft's Markdown as `hp-medium:{key}`. A missing " +
      "draft is created unless `createIfMissing` is `false`, which keeps " +
      "pre-upgrade composers working while the current composer requires the " +
      "draft it already created. The viewer must own the draft or be an " +
      "accepted member of its owning organization. Re-attaching the same key " +
      "to the same medium is idempotent; pointing an existing key at a " +
      "different medium is rejected. Requires authentication.",
    inputFields: (t) => ({
      draftId: t.field({ type: "UUID", required: true }),
      mediumId: t.field({ type: "UUID", required: true }),
      key: t.string({
        required: false,
        description:
          "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
      }),
      createIfMissing: t.boolean({
        required: false,
        description:
          "When `true` (the default), a missing draft is created, which keeps " +
          "pre-upgrade composers working during the rollout. Set `false` to " +
          "require the draft to already exist, so a publish or delete racing " +
          "an attachment cannot recreate it.",
      }),
    }),
  },
  {
    errors: { types: [NotAuthenticatedError, InvalidInputError] },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const viewer = ctx.account;
      const key = args.input.key?.trim() || args.input.mediumId;
      if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
        throw new InvalidInputError("key");
      }
      const result = await withTransaction(ctx.fedCtx, async (tx) => {
        // Lock the draft so a concurrent publish cannot delete it between the
        // access check and the attachment insert.
        const draftRows = await tx.db
          .select()
          .from(articleDraftTable)
          .where(eq(articleDraftTable.id, args.input.draftId))
          .for("update");
        let draft = draftRows[0];
        if (draft == null) {
          if (args.input.createIfMissing === false) return "draft" as const;
          // Transition path for pre-upgrade composers, which upload before the
          // first save. New clients create the draft explicitly first and pass
          // `createIfMissing: false`.
          const inserted = await tx.db
            .insert(articleDraftTable)
            .values({
              id: args.input.draftId,
              accountId: viewer.id,
              creatorId: viewer.id,
              title: "",
              content: "",
              tags: [],
              revision: 1,
            })
            .onConflictDoNothing()
            .returning();
          draft = inserted[0];
        } else if (!(await canAccountActAs(tx.db, viewer, draft.accountId))) {
          return "draft" as const;
        }
        if (draft == null) return "draft" as const;
        const medium = await tx.db.query.mediumTable.findFirst({
          where: { id: args.input.mediumId },
        });
        if (medium == null) return "medium" as const;
        const existing = await tx.db.query.articleDraftMediumTable.findFirst({
          where: { articleDraftId: draft.id, key },
        });
        if (existing != null && existing.mediumId !== medium.id) {
          return "key" as const;
        }
        if (existing == null) {
          await tx.db.insert(articleDraftMediumTable).values({
            articleDraftId: draft.id,
            key,
            mediumId: medium.id,
          });
        }
        return { key, medium };
      });
      if (result === "draft") throw new InvalidInputError("draftId");
      if (result === "medium") throw new InvalidInputError("mediumId");
      if (result === "key") throw new InvalidInputError("key");
      return result satisfies AttachedArticleDraftMedium;
    },
  },
  {
    outputFields: (t) => ({
      key: t.string({ resolve: (result) => result.key }),
      medium: t.field({
        type: Medium,
        resolve: (result) => result.medium,
      }),
    }),
  },
);

interface AttachedArticleSourceMedium {
  key: string;
  medium: schema.Medium;
}

builder.relayMutationField(
  "attachArticleSourceMedium",
  {
    description:
      "Associate an uploaded `Medium` with a published article so it can " +
      "be referenced in the article's Markdown as `hp-medium:{key}`. Use " +
      "this when adding new media to an article during editing: pair each " +
      "attach call with an `hp-medium:` reference in the new content " +
      "passed to `updateArticle`. The viewer must own the article. " +
      "Requires authentication.",
    inputFields: (t) => ({
      articleSourceId: t.field({
        type: "UUID",
        required: true,
        description:
          "UUID of the `ArticleSource` to attach the medium to. The viewer " +
          "must be the article's author.",
      }),
      actingAccountId: t.globalID({
        for: [Account],
        required: false,
        description: actingAccountIdArgDescription,
      }),
      mediumId: t.field({
        type: "UUID",
        required: true,
        description: "UUID of a `Medium` to make available to the article.",
      }),
      key: t.string({
        required: false,
        description:
          "Key used in article markdown as hp-medium:KEY. Defaults to mediumId.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        InvalidInputError,
        OrganizationPermissionError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new NotAuthenticatedError();
      const actingAccount = await resolveActingAccountForMutation(
        ctx,
        args.input,
      );
      if (!validateUuid(args.input.articleSourceId)) {
        throw new InvalidInputError("articleSourceId");
      }
      const source = await ctx.db.query.articleSourceTable.findFirst({
        where: { id: args.input.articleSourceId },
        columns: { id: true, accountId: true },
      });
      if (source == null || source.accountId !== actingAccount.id) {
        throw new InvalidInputError("articleSourceId");
      }
      const medium = await ctx.db.query.mediumTable.findFirst({
        where: { id: args.input.mediumId },
      });
      if (medium == null) throw new InvalidInputError("mediumId");
      // During the upload window the medium is private to its uploader.
      // Block attaching a freshly-uploaded medium that belongs to someone
      // else, matching the ownership check used by `Medium.generatedAltText`.
      // After the window expires the medium is either publicly referenced
      // or pending orphan cleanup, so any authenticated owner of the
      // target article may attach it.
      const owner = await isMediumOwner(ctx.kv, medium.id, session.accountId);
      if (!owner) {
        const windowActive = await isMediumUploadWindowActive(
          ctx.kv,
          medium.id,
        );
        if (windowActive) throw new NotAuthorizedError();
      }
      const key = args.input.key?.trim() || medium.id;
      if (!key.match(/^[A-Za-z0-9._:/-]+$/)) {
        throw new InvalidInputError("key");
      }
      // Don't silently overwrite an existing row. A published article's
      // rendered HTML resolves `hp-medium:KEY` against this table at
      // request time, so changing the `mediumId` for an in-use key would
      // change the live article without going through `updateArticle`
      // (no timestamp bump, no ActivityPub `Update`). Treat re-attaching
      // the same medium as idempotent; reject conflicting medium IDs.
      const inserted = await ctx.db
        .insert(articleSourceMediumTable)
        .values({
          articleSourceId: source.id,
          key,
          mediumId: medium.id,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        const existing = await ctx.db.query.articleSourceMediumTable.findFirst({
          where: { articleSourceId: source.id, key },
        });
        if (existing == null || existing.mediumId !== medium.id) {
          throw new InvalidInputError("key");
        }
      }
      return { key, medium } satisfies AttachedArticleSourceMedium;
    },
  },
  {
    outputFields: (t) => ({
      key: t.string({
        description:
          "The key the medium was attached under. Reference it in the " +
          "article's Markdown as `hp-medium:KEY`. Equals the requested " +
          "`key` input when provided, otherwise the medium's UUID.",
        resolve: (result) => result.key,
      }),
      medium: t.field({
        type: Medium,
        description: "The `Medium` that was attached to the article source.",
        resolve: (result) => result.medium,
      }),
    }),
  },
);

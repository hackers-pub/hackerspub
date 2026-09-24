import { renderCustomEmojis } from "@hackerspub/models/emoji";
import {
  addExternalLinkTargets,
  removeQuoteInlineFallback,
  sanitizeExcerptHtml,
  sanitizeHtml,
  stripHtml,
  transformMentions,
  truncateHtml,
} from "@hackerspub/models/html";
import { negotiateLocale } from "@hackerspub/models/i18n";
import type * as schema from "@hackerspub/models/schema";
import { Actor } from "../actor.ts";
import { builder, type UserContext } from "../builder.ts";
import { isCensoredForViewer, Post, sanctionActorSelection } from "./core.ts";

export const PostTranslationKind = builder.enumType("PostTranslationKind", {
  description:
    "How a translated `PostContentVariant` was produced, as far as it is " +
    "known. For local articles it follows `ArticleContent.provenance`; for " +
    "remote posts it is derived from the actor types the publisher credited " +
    "in its [FEP-22cd](https://w3id.org/fep/22cd) metadata.",
  values: {
    HUMAN: {
      value: "human",
      description:
        "Translated by people (only `Person`, `Organization`, or `Group` " +
        "actors are credited).",
    },
    MACHINE: {
      value: "machine",
      description:
        "Machine output that no person reviewed (only `Application` or " +
        "`Service` actors are credited).",
    },
    MACHINE_REVIEWED: {
      value: "machine_reviewed",
      description:
        "Machine output reviewed by a person. The credited person reviewed " +
        "it; do not present them as having translated it from scratch.",
    },
    UNKNOWN: {
      value: "unknown",
      description:
        "Not established: a legacy local version, or a remote one whose " +
        "credited actors could not all be resolved or that credits nobody. " +
        "Never present this as either human or machine translation.",
    },
  } as const,
});

export const PostTranslationFreshness = builder.enumType(
  "PostTranslationFreshness",
  {
    description:
      "Whether a translated `PostContentVariant` reflects the current " +
      "version of its source.",
    values: {
      CURRENT: {
        value: "current",
        description: "The translation was reviewed against the current source.",
      },
      SOURCE_CHANGED: {
        value: "source_changed",
        description:
          "The source changed after the translation was last reviewed, so " +
          "it may miss those changes. It does not mean the translation is " +
          "wrong.",
      },
      UNKNOWN: {
        value: "unknown",
        description:
          "No freshness information: nobody recorded which source version " +
          "the translation follows (or, for a remote post, the publisher " +
          "made no claim). Never present this as `CURRENT` or as a known " +
          "source change.",
      },
    } as const,
  },
);

/** The post columns a variant needs to render and redact itself. */
const variantPostSelection = {
  columns: {
    id: true,
    actorId: true,
    censored: true,
    contentHtml: true,
    emojis: true,
    iri: true,
    sharedPostId: true,
    language: true,
    name: true,
    quotedPostId: true,
    summary: true,
    tags: true,
    url: true,
  },
  with: {
    actor: {
      columns: {
        ...sanctionActorSelection.columns,
        iri: true,
        handle: true,
      },
    },
    mentions: { with: { actor: true } },
    sharedPost: {
      columns: { censored: true, actorId: true },
      with: { actor: sanctionActorSelection },
    },
    contentVariants: true,
  },
} as const;

type VariantPost = Pick<
  schema.Post,
  | "id"
  | "sharedPostId"
  | "actorId"
  | "censored"
  | "contentHtml"
  | "emojis"
  | "iri"
  | "language"
  | "name"
  | "quotedPostId"
  | "summary"
  | "tags"
  | "url"
> & {
  actor: Pick<
    schema.Actor,
    "accountId" | "suspended" | "suspendedUntil" | "iri" | "handle"
  >;
  mentions: (schema.Mention & { actor: schema.Actor })[];
  sharedPost?: {
    censored: Date | null;
    actorId: schema.Post["actorId"];
    actor: Pick<schema.Actor, "accountId" | "suspended" | "suspendedUntil">;
  } | null;
  contentVariants: schema.PostContentVariant[];
};

type VariantData = Pick<
  schema.PostContentVariant,
  | "language"
  | "default"
  | "originalLanguage"
  | "url"
  | "name"
  | "summary"
  | "contentHtml"
  | "translationKind"
  | "translatorIris"
  | "freshness"
  | "sourceUpdated"
>;

interface PostContentVariantShape {
  readonly post: VariantPost;
  readonly variant: VariantData;
  /** Whether the post is local (claims are the platform's own). */
  readonly local: boolean;
  /** Content-bearing fields are emptied for this viewer. */
  readonly redacted: boolean;
}

interface PostContentTranslationShape {
  readonly post: VariantPost;
  readonly variant: VariantData;
  readonly local: boolean;
}

function toShapes(
  post: VariantPost,
  ctx: UserContext,
): PostContentVariantShape[] {
  const redacted = isCensoredForViewer(post, ctx);
  const local = post.actor.accountId != null;
  if (post.contentVariants.length > 0) {
    const variants = [...post.contentVariants].sort(
      (a, b) =>
        Number(b.default) - Number(a.default) ||
        (a.language ?? "").localeCompare(b.language ?? ""),
    );
    return variants.map((variant) => ({ post, variant, local, redacted }));
  }
  // A post without stored variants (single-language remote posts, notes and
  // questions, local articles not yet backfilled) is represented by its
  // representative row alone.
  return [
    {
      post,
      local,
      redacted,
      variant: {
        language: post.language,
        default: true,
        originalLanguage: null,
        url: post.url,
        name: post.name,
        summary: post.summary,
        contentHtml: post.contentHtml,
        translationKind: null,
        translatorIris: [],
        freshness: null,
        sourceUpdated: null,
      },
    },
  ];
}

/**
 * Remote HTML as stored is attacker-controlled. The language alternatives
 * are newly reachable through variants, so they are sanitized here; local
 * variants were already sanitized when rendered from Markdown.
 */
function trustedHtml(shape: PostContentVariantShape, html: string): string {
  return shape.local ? html : sanitizeHtml(html);
}

function renderVariantHtml(
  shape: PostContentVariantShape,
  ctx: UserContext,
): string {
  let html = renderCustomEmojis(
    trustedHtml(shape, shape.variant.contentHtml),
    shape.post.emojis,
  );
  html = transformMentions(html, shape.post.mentions, shape.post.tags);
  html = addExternalLinkTargets(html, new URL(ctx.fedCtx.canonicalOrigin));
  if (shape.post.quotedPostId != null) html = removeQuoteInlineFallback(html);
  return html;
}

export const PostContentTranslation = builder
  .objectRef<PostContentTranslationShape>("PostContentTranslation")
  .implement({
    description:
      "Translation metadata of one `PostContentVariant`, following " +
      "[FEP-22cd](https://w3id.org/fep/22cd). For remote posts every field " +
      "is a claim made by the publishing server (see `publisherAsserted`): " +
      "it is not verified, and the credited translators gain no authority " +
      "over the post.",
    fields: (t) => ({
      kind: t.field({
        type: PostTranslationKind,
        description:
          "How the translation was produced. Prefer this over inspecting " +
          "`translators`: a deleted or unresolved account must not turn " +
          "human work into machine output or the reverse.",
        resolve: (shape) => shape.variant.translationKind ?? "unknown",
      }),
      freshness: t.field({
        type: PostTranslationFreshness,
        description:
          "Whether the translation reflects the current source. Show a " +
          "notice for `SOURCE_CHANGED`, and never present `UNKNOWN` as " +
          "current.",
        resolve: (shape) => shape.variant.freshness ?? "unknown",
      }),
      sourceUpdated: t.field({
        type: "DateTime",
        nullable: true,
        description:
          "The FEP-22cd `sourceUpdated` value: the source's `updated` (or " +
          "`published`) timestamp this translation is known to reflect. " +
          "`null` when no claim is made, which is always the case for " +
          "unreviewed machine output.",
        resolve: (shape) => shape.variant.sourceUpdated,
      }),
      translatorIris: t.field({
        type: ["URL"],
        description:
          "IRIs of every actor credited for this translation, exactly as " +
          "published, including actors this server cannot resolve and " +
          "deleted accounts (whose IRIs now resolve to a `Tombstone`). " +
          "Their order has no meaning. Empty for a legacy version whose " +
          "translator is unknown.",
        resolve: (shape) =>
          shape.variant.translatorIris.flatMap((iri) => {
            try {
              return [new URL(iri)];
            } catch {
              return [];
            }
          }),
      }),
      translators: t.field({
        type: [Actor],
        description:
          "The credited actors this server knows, a subset of " +
          "`translatorIris`. Use it to link to their profiles; an IRI " +
          "missing here is not evidence of machine translation.",
        resolve: async (shape, _, ctx) => {
          if (shape.variant.translatorIris.length < 1) return [];
          return await ctx.db.query.actorTable.findMany({
            where: { iri: { in: shape.variant.translatorIris } },
          });
        },
      }),
      byAuthor: t.boolean({
        description:
          "Whether the post's own attributed actor is among the credited " +
          "translators, so the credit can read as translated by the author.",
        resolve: (shape) =>
          shape.variant.translatorIris.includes(shape.post.actor.iri),
      }),
      publisherAsserted: t.boolean({
        description:
          "`true` for a remote post: the metadata was asserted by the " +
          "publishing server and not verified here. `false` for a local " +
          "article, whose metadata this server records itself.",
        resolve: (shape) => !shape.local,
      }),
    }),
  });

export const PostContentVariant = builder
  .objectRef<PostContentVariantShape>("PostContentVariant")
  .implement({
    description:
      "One language version of a post's content. Remote posts get one per " +
      "language in the ActivityStreams `contentMap`; local articles get one " +
      "per published language version. A post that published no language " +
      "alternatives has a single variant built from its own fields. " +
      "Content-bearing fields are emptied under the same censorship and " +
      "moderation-sanction rules as `Post.content`.",
    fields: (t) => ({
      language: t.field({
        type: "Locale",
        nullable: true,
        description:
          "BCP 47 language tag of this variant. `null` when the publisher " +
          "supplied a default value without a language tag.",
        resolve: (shape) => shape.variant.language,
      }),
      default: t.boolean({
        description:
          "Whether this is the default variant: the ActivityPub default " +
          "value for a remote post, or the original language for a local " +
          "article. At most one variant of a post is the default.",
        resolve: (shape) => shape.variant.default,
      }),
      originalLanguage: t.field({
        type: "Locale",
        nullable: true,
        description:
          "The language this variant was translated from, when known. " +
          "`null` for a default or original variant and for remote language " +
          "alternatives, which are not necessarily translations; use " +
          "`translation` to tell whether one is.",
        resolve: (shape) => shape.variant.originalLanguage,
      }),
      url: t.field({
        type: "URL",
        description:
          "Web page of this language version when the publisher has one, " +
          "otherwise the post's own URL (or IRI).  When the content is " +
          "redacted for the viewer, a remote post or boost wrapper gets the " +
          "local permalink that renders the notice instead, like `Post.iri`.",
        resolve: (shape, _, ctx) => {
          // Mirror `Post.iri`: a hidden remote post or boost wrapper would
          // otherwise link to the uncensored copy on its origin, so it gets
          // the local permalink that renders the notice instead.
          if (
            shape.redacted &&
            (shape.post.sharedPostId != null || !shape.local)
          ) {
            return new URL(
              `/${shape.post.actor.handle}/${shape.post.id}`,
              ctx.fedCtx.canonicalOrigin,
            );
          }
          for (const value of [
            shape.variant.url,
            shape.post.url,
            shape.post.iri,
          ]) {
            if (value == null) continue;
            try {
              return new URL(value);
            } catch {
              continue;
            }
          }
          return new URL(shape.post.iri);
        },
      }),
      name: t.string({
        nullable: true,
        description:
          "Title in this language. `null` when the publisher gave no title " +
          "in this language (it never falls back to another language) or " +
          "when the content is redacted for the viewer.",
        resolve: (shape) => (shape.redacted ? null : shape.variant.name),
      }),
      summary: t.string({
        nullable: true,
        description:
          "Summary in this language, or `null` when there is none or the " +
          "content is redacted for the viewer.",
        resolve: (shape) =>
          shape.redacted || shape.variant.summary == null
            ? null
            : trustedHtml(shape, shape.variant.summary),
      }),
      content: t.field({
        type: "HTML",
        description:
          "Full HTML content in this language, rendered like " +
          "`Post.content`. Empty when redacted for the viewer.",
        resolve: (shape, _, ctx) =>
          shape.redacted ? "" : renderVariantHtml(shape, ctx),
      }),
      excerpt: t.string({
        description:
          "Plain-text excerpt: `summary` when set, otherwise the content " +
          "stripped of tags. Empty when redacted for the viewer.",
        resolve: (shape) => {
          if (shape.redacted) return "";
          // Remote summaries can carry markup, and this field is plain text.
          if (shape.variant.summary != null) {
            return stripHtml(shape.variant.summary);
          }
          let html = shape.variant.contentHtml;
          if (shape.post.quotedPostId != null) {
            html = removeQuoteInlineFallback(html);
          }
          return stripHtml(html);
        },
      }),
      excerptHtml: t.field({
        type: "HTML",
        description:
          "A sanitized HTML preview clipped to about `maxChars` visible " +
          "characters, like `Post.excerptHtml`. It does not fall back to " +
          "`summary`. Empty when redacted for the viewer.",
        args: {
          maxChars: t.arg.int({
            required: true,
            description: "Approximate number of visible characters to keep.",
          }),
        },
        resolve: (shape, args) => {
          if (shape.redacted) return "";
          let html = shape.variant.contentHtml;
          if (shape.post.quotedPostId != null) {
            html = removeQuoteInlineFallback(html);
          }
          return truncateHtml(
            renderCustomEmojis(sanitizeExcerptHtml(html), shape.post.emojis),
            args.maxChars,
          );
        },
      }),
      translation: t.field({
        type: PostContentTranslation,
        nullable: true,
        description:
          "Translation credit and freshness, or `null` when this variant is " +
          "not known to be a translation (an original, a default value, or " +
          "a remote language alternative without FEP-22cd metadata), or " +
          "when the content is redacted for the viewer.",
        resolve: (shape) =>
          shape.redacted || shape.variant.translationKind == null
            ? null
            : { post: shape.post, variant: shape.variant, local: shape.local },
      }),
    }),
  });

builder.drizzleInterfaceFields(Post, (t) => ({
  contentVariant: t.field({
    type: PostContentVariant,
    description:
      "The best content variant for `language`: BCP 47 negotiation among " +
      "`contentVariants` first, then the default variant. Omit `language` " +
      "to get the default variant. Use this to render a post in the " +
      "reader's language.",
    args: {
      language: t.arg({
        type: "Locale",
        required: false,
        description: "The preferred language, usually the viewer's locale.",
      }),
    },
    select: variantPostSelection,
    resolve: (post, args, ctx) => {
      const shapes = toShapes(post as unknown as VariantPost, ctx);
      if (args.language != null) {
        const tagged = shapes.filter((s) => s.variant.language != null);
        const selected = negotiateLocale(
          args.language,
          tagged.map((s) => s.variant.language!),
        );
        // `negotiateLocale` hands back canonical tags, while stored content
        // languages can keep an alias (`tl` canonicalizes to `fil`), so the
        // comparison has to canonicalize both sides.
        const match = tagged.find((s) => {
          try {
            return (
              new Intl.Locale(s.variant.language!).baseName ===
              selected?.baseName
            );
          } catch {
            return s.variant.language === selected?.baseName;
          }
        });
        if (match != null) return match;
      }
      return shapes.find((s) => s.variant.default) ?? shapes[0];
    },
  }),
  contentVariants: t.field({
    type: [PostContentVariant],
    description:
      "Every stored content variant of this post, default first. Not " +
      "paginated: it mirrors the bounded language alternatives of one " +
      "ActivityPub object. It lists content-bearing variants only; a " +
      "title- or summary-only language entry never appears by itself.",
    select: variantPostSelection,
    resolve: (post, _, ctx) => toShapes(post as unknown as VariantPost, ctx),
  }),
}));

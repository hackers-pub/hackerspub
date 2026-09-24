import type { DocumentLoader } from "@fedify/fedify";
import { isActor, LanguageString } from "@fedify/vocab";
import type * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import { persistActor } from "../actor.ts";
import type { ApplicationContext } from "../context.ts";
import type { Database, Transaction } from "../db.ts";
import {
  type ActorType,
  type NewPostContentVariant,
  postContentVariantTable,
  type PostTranslationFreshness,
  type PostTranslationKind,
} from "../schema.ts";
import { generateUuidV7, type Uuid } from "../uuid.ts";
import type { PostObject } from "./core.ts";

const logger = getLogger(["hackerspub", "models", "post", "content-variant"]);

/** At most this many translator IRIs are kept for one language. */
export const MAX_TRANSLATOR_IRIS = 10;

/**
 * At most this many unknown translator actors are fetched while persisting
 * one object, so a translation list cannot turn an inbox job into an
 * unbounded crawl. Unresolved translators make the classification `unknown`.
 */
export const MAX_TRANSLATOR_LOOKUPS = 3;

/** A remote variant before it is attached to a stored post. */
export type RemoteContentVariant = Omit<NewPostContentVariant, "id" | "postId">;

function languageTag(value: LanguageString): string | null {
  try {
    return new Intl.Locale(value.locale.toString()).baseName;
  } catch {
    return null;
  }
}

function sameLanguage(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  try {
    return (
      Intl.getCanonicalLocales(a)[0].toLowerCase() ===
      Intl.getCanonicalLocales(b)[0].toLowerCase()
    );
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/**
 * Splits an object's natural language values into content variants, following
 * the rules agreed in issue #330:
 *
 *  -  Variants come from the `content`/`contentMap` language set; `nameMap` and
 *     `summaryMap` entries attach to the same-language variant and never
 *     create one by themselves.
 *  -  An untagged `content` identical to one of the tagged values marks that
 *     variant as the default instead of being stored twice; otherwise it is
 *     stored as its own default variant with a `null` language.
 *  -  An object with no language-tagged content yields no variants: the post
 *     row itself is its only representation.
 */
export function buildRemoteContentVariants(
  post: PostObject,
): RemoteContentVariant[] {
  const tagged: RemoteContentVariant[] = [];
  let untagged: string | null = null;
  for (const value of post.contents) {
    if (value instanceof LanguageString) {
      const language = languageTag(value);
      if (language == null) continue;
      if (tagged.some((v) => sameLanguage(v.language ?? null, language))) {
        continue;
      }
      tagged.push({
        language,
        default: false,
        contentHtml: value.toString(),
        name: null,
        summary: null,
      });
    } else if (untagged == null) {
      untagged = value.toString();
    }
  }
  if (tagged.length < 1) return [];
  const attach = (
    values: readonly (string | LanguageString)[],
    field: "name" | "summary",
  ) => {
    for (const value of values) {
      if (!(value instanceof LanguageString)) continue;
      const language = languageTag(value);
      const variant = tagged.find((v) =>
        sameLanguage(v.language ?? null, language),
      );
      if (variant != null && variant[field] == null) {
        variant[field] = value.toString();
      }
    }
  };
  attach(post.names, "name");
  attach(post.summaries, "summary");
  const plainName = post.names.find((n) => !(n instanceof LanguageString));
  const plainSummary = post.summaries.find(
    (s) => !(s instanceof LanguageString),
  );
  // Whichever variant becomes the default also carries the untagged title and
  // summary when it has none of its own: they describe the default value.
  const markDefault = (variant: RemoteContentVariant) => {
    variant.default = true;
    variant.name ??= plainName == null ? null : plainName.toString();
    variant.summary ??= plainSummary == null ? null : plainSummary.toString();
    return tagged;
  };
  if (untagged == null) {
    // With only a language map, the object's default value is its first
    // entry, which is what `post.contentHtml` already stores.
    return markDefault(tagged[0]);
  }
  const match = tagged.find((v) => v.contentHtml === untagged);
  if (match != null) return markDefault(match);
  return [
    {
      language: null,
      default: true,
      contentHtml: untagged,
      name: plainName == null ? null : plainName.toString(),
      summary: plainSummary == null ? null : plainSummary.toString(),
    },
    ...tagged,
  ];
}

function classify(types: readonly (ActorType | null)[]): PostTranslationKind {
  if (types.length < 1 || types.some((type) => type == null)) return "unknown";
  const human = types.some(
    (type) => type === "Person" || type === "Organization" || type === "Group",
  );
  const machine = types.some(
    (type) => type === "Application" || type === "Service",
  );
  if (human && machine) return "machine_reviewed";
  if (machine) return "machine";
  return "human";
}

/**
 * The language version's web page, kept only when it is an `http(s)` URL:
 * readers follow it as a link, so a `javascript:` or `data:` URL from a
 * remote publisher must never be stored.
 */
function linkHref(value: URL | vocab.Link | null): string | null {
  const url = value instanceof URL ? value : (value?.href ?? null);
  if (url == null) return null;
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : null;
}

export interface AttachTranslationMetadataOptions {
  /**
   * Whether unknown translator actors may be fetched. `false` inside an inbox
   * transaction, where only already known actors are used.
   */
  readonly fetchRemote: boolean;
  readonly documentLoader?: DocumentLoader;
  readonly contextLoader?: DocumentLoader;
}

/**
 * Attaches FEP-22cd translation metadata from `post.translations` to the
 * variants built by {@link buildRemoteContentVariants}.
 *
 * Everything here is a claim made by the publishing server: it is stored as
 * such, never verified, and never grants the named translators anything.
 * Malformed metadata never blocks the core content; the policy is to drop the
 * offending entry:
 *
 *  -  an entry without a language, or whose language has no content variant;
 *  -  an entry whose `translationOfWork` is missing or is not this object;
 *  -  every entry for a language that has more than one (ambiguous).
 *
 * Translator IRIs other than `http(s)` are ignored and at most
 * {@link MAX_TRANSLATOR_IRIS} are kept. The human-or-machine classification is
 * computed now from known actor types (fetching at most
 * {@link MAX_TRANSLATOR_LOOKUPS} unknown actors when allowed), so a later
 * deletion of an actor does not reclassify a stored translation; any actor
 * that cannot be resolved makes it `unknown`, as the FEP requires.
 * Freshness compares `sourceUpdated` with this object's own reference
 * timestamp (`updated`, or `published`); no `sourceUpdated` means no claim.
 */
export async function attachTranslationMetadata(
  ctx: ApplicationContext,
  post: PostObject,
  variants: RemoteContentVariant[],
  options: AttachTranslationMetadataOptions,
): Promise<void> {
  if (variants.length < 1 || post.id == null) return;
  let entries: readonly vocab.Translation[];
  try {
    entries = post.translations;
  } catch (error) {
    logger.debug("Ignoring malformed translation metadata on {iri}: {error}", {
      iri: post.id.href,
      error,
    });
    return;
  }
  if (entries.length < 1) return;
  const byLanguage = new Map<string, vocab.Translation[]>();
  for (const entry of entries) {
    const language = entry.language?.baseName ?? null;
    const variant = variants.find((v) =>
      sameLanguage(v.language ?? null, language),
    );
    if (variant?.language == null) continue;
    if (entry.original?.href !== post.id.href) continue;
    const list = byLanguage.get(variant.language) ?? [];
    list.push(entry);
    byLanguage.set(variant.language, list);
  }
  const reference = post.updated ?? post.published;
  let lookups = 0;
  const typeCache = new Map<string, ActorType | null>();
  const resolveType = async (iri: string): Promise<ActorType | null> => {
    if (typeCache.has(iri)) return typeCache.get(iri)!;
    let type: ActorType | null = null;
    const known = await ctx.db.query.actorTable.findFirst({
      where: { iri },
      columns: { type: true },
    });
    if (known != null) {
      type = known.type;
    } else if (options.fetchRemote && lookups < MAX_TRANSLATOR_LOOKUPS) {
      lookups++;
      try {
        const object = await ctx.lookupObject(iri, {
          documentLoader: options.documentLoader,
          contextLoader: options.contextLoader,
        });
        if (isActor(object)) {
          const actor = await persistActor(ctx, object, {
            documentLoader: options.documentLoader,
            contextLoader: options.contextLoader,
          });
          type = actor?.type ?? null;
        }
      } catch (error) {
        logger.debug("Failed to resolve translator {iri}: {error}", {
          iri,
          error,
        });
      }
    }
    typeCache.set(iri, type);
    return type;
  };
  for (const [language, list] of byLanguage) {
    if (list.length !== 1) continue;
    const [entry] = list;
    const variant = variants.find((v) => v.language === language)!;
    const credited = [...new Set(entry.translatorIds.map((iri) => iri.href))];
    const iris = credited
      .filter((iri) => iri.startsWith("https:") || iri.startsWith("http:"))
      .slice(0, MAX_TRANSLATOR_IRIS);
    const types: (ActorType | null)[] = [];
    for (const iri of iris) types.push(await resolveType(iri));
    // A credited actor that was dropped (unsupported scheme, or past the cap)
    // is one whose type is unknown, so it must not let the rest decide.
    if (iris.length < credited.length) types.push(null);
    const sourceUpdated = entry.sourceUpdated;
    let freshness: PostTranslationFreshness = "unknown";
    if (sourceUpdated != null && reference != null) {
      freshness =
        Temporal.Instant.compare(sourceUpdated, reference) < 0
          ? "source_changed"
          : "current";
    }
    variant.translationKind = classify(types);
    variant.translatorIris = iris;
    variant.freshness = freshness;
    variant.sourceUpdated =
      sourceUpdated == null ? null : new Date(sourceUpdated.epochMilliseconds);
    variant.url = linkHref(entry.url);
  }
}

/**
 * Replaces every stored variant of a post with the given set.
 *
 * Variants are replaced wholesale: an accepted `Update` carries the object's
 * full state, so a language (or its translation metadata) that it omits has
 * been withdrawn, not merely left unmentioned.
 */
export async function replacePostContentVariants(
  db: Database | Transaction,
  postId: Uuid,
  variants: readonly RemoteContentVariant[],
): Promise<void> {
  await db
    .delete(postContentVariantTable)
    .where(eq(postContentVariantTable.postId, postId));
  if (variants.length < 1) return;
  await db
    .insert(postContentVariantTable)
    .values(variants.map((v) => ({ ...v, id: generateUuidV7(), postId })));
}

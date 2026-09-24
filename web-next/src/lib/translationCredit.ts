/**
 * Reader-facing classification of a published article language version.
 *
 * The article page, the language menu, and the article card all have to agree
 * on three questions: who is credited for this version, how much machine
 * assistance it is known to have had, and whether its translation may be
 * missing changes made to the original. Keeping the answers here (rather than
 * inside the components) makes them testable without a DOM and makes it
 * impossible for two surfaces to describe the same row differently.
 *
 * Two rules drive every mapping below:
 *
 *  -  Never relabel human work as automatic. `provenance` is authoritative,
 *     not `translator`, because the account reference becomes `null` when the
 *     account is deleted while the provenance does not change.
 *  -  Never claim the original changed when the baseline is unknown. Anything
 *     that is not a recorded `NEEDS_REVIEW` falls back to unverified freshness.
 */

/**
 * How much machine assistance a published version is known to have had.
 *
 * `"unknown"` is not "none": it is the legacy classification for a version
 * reopened from content published before provenance was tracked.
 */
export type TranslationAssistance = "none" | "llm" | "unknown";

/** The account credited as a version's translator, as the UI needs it. */
export interface TranslationCreditAccount {
  readonly id: string;
  readonly username: string;
  readonly handle: string;
}

/**
 * Who a reader should be told produced this language version.
 *
 * `unavailable` and `unknown` are deliberately distinct: the first is a
 * human-managed version whose credited account was deleted, the second is a
 * version whose provenance was never established. Collapsing them would either
 * invent a deleted account or drop a real credit.
 *
 * `translating` is the placeholder row an automatic translation leaves behind
 * while it runs. It carries `provenance: LLM` and the original's text, so
 * describing it as an automatic translation would promise a reader a
 * translated version that does not exist yet.
 */
export type TranslationCredit =
  | { readonly kind: "original" }
  | { readonly kind: "translating" }
  | { readonly kind: "automatic" }
  | { readonly kind: "author"; readonly assistance: TranslationAssistance }
  | {
      readonly kind: "account";
      readonly assistance: TranslationAssistance;
      readonly account: TranslationCreditAccount;
    }
  | { readonly kind: "unavailable"; readonly assistance: TranslationAssistance }
  | { readonly kind: "unknown" };

/**
 * The subset of `ArticleContent` the credit and freshness helpers read.
 *
 * `provenance` and `reviewState` are typed as `string` rather than as the
 * generated Relay enums on purpose: the generated unions include
 * `"%future added value"`, and accepting a plain string lets an enum added to
 * the schema fall through to the neutral branches here instead of failing to
 * type-check at every call site and then being labelled by accident.
 */
export interface TranslationContent {
  readonly originalLanguage?: string | null;
  readonly provenance?: string | null;
  readonly reviewState?: string | null;
  readonly beingTranslated?: boolean | null;
  readonly translator?: TranslationCreditAccount | null;
}

function assistanceOf(provenance: string): TranslationAssistance {
  switch (provenance) {
    case "HUMAN":
      return "none";
    case "LLM_REVIEWED":
      return "llm";
    default:
      return "unknown";
  }
}

/**
 * Classifies one published language version for display.
 *
 * @param content The version being described. A row whose `originalLanguage`
 *                is `null` is the article's original text, which has no
 *                translator and never carries a credit line.
 * @param authorAccountIds Account IDs that are presented to readers as this
 *                         article's author, from
 *                         {@link articleAuthorAccountIds}. A translator in
 *                         this set is credited as "the author" instead of by
 *                         handle.
 */
export function translationCredit(
  content: TranslationContent,
  authorAccountIds: ReadonlySet<string>,
): TranslationCredit {
  // The schema guarantees `originalLanguage` is non-null for every translated
  // row, so it — not `provenance` — is what distinguishes the original.
  if (content.originalLanguage == null) return { kind: "original" };
  if (content.beingTranslated) return { kind: "translating" };
  const provenance = content.provenance;
  if (provenance === "LLM") return { kind: "automatic" };
  const translator = content.translator ?? null;
  if (provenance == null) {
    // A translated row without a provenance violates the database check
    // constraint, so this is unreachable in practice; treat it as unclassified
    // rather than guessing.
    return translator == null
      ? { kind: "unknown" }
      : { kind: "account", assistance: "unknown", account: translator };
  }
  const assistance = assistanceOf(provenance);
  if (translator == null) {
    // A deleted account must not turn human work into an automatic
    // translation, but there is nothing to credit when the provenance itself
    // is unknown.
    return assistance === "unknown"
      ? { kind: "unknown" }
      : { kind: "unavailable", assistance };
  }
  if (authorAccountIds.has(translator.id))
    return { kind: "author", assistance };
  return { kind: "account", assistance, account: translator };
}

/** The shape of `Article.organizationAuthor` this module reads. */
export interface TranslationArticleAuthor {
  readonly account?: { readonly id: string } | null;
  readonly organizationAuthor?:
    | {
        readonly attributionMode?: string | null;
        readonly member?: { readonly id: string } | null;
      }
    | null
    | undefined;
}

/**
 * The account IDs a reader sees as this article's author.
 *
 * The owning account is always one of them. An organization's credited member
 * counts only under `ACTING_ACCOUNT_WITH_VIEWER`, because
 * `ACTING_ACCOUNT_ONLY` deliberately does not present that person as an
 * author: crediting their translation as "by the author" would then be a
 * statement the page never made. Their translator credit is still shown by
 * handle, which is a separate, publicly stored credit.
 */
export function articleAuthorAccountIds(
  article: TranslationArticleAuthor,
): ReadonlySet<string> {
  const ids = new Set<string>();
  const accountId = article.account?.id;
  if (accountId != null) ids.add(accountId);
  const organizationAuthor = article.organizationAuthor;
  if (
    organizationAuthor?.attributionMode === "ACTING_ACCOUNT_WITH_VIEWER" &&
    organizationAuthor.member?.id != null
  ) {
    ids.add(organizationAuthor.member.id);
  }
  return ids;
}

/**
 * Whether a reader should be warned that a translation may be behind its
 * original.
 *
 * `"unverified"` is the fallback for every state that is not a recorded
 * `CURRENT` or `NEEDS_REVIEW`, so an unrecorded baseline is never presented as
 * a known source change.
 */
export type TranslationFreshness = "current" | "source-changed" | "unverified";

/**
 * Computes the freshness signal for one version, or `null` when freshness does
 * not apply: the original has nothing to be behind, and a version still being
 * machine-translated is not yet a translation a reader can evaluate.
 */
export function translationFreshness(
  content: TranslationContent,
): TranslationFreshness | null {
  if (content.originalLanguage == null) return null;
  if (content.beingTranslated) return null;
  switch (content.reviewState) {
    case "CURRENT":
      return "current";
    case "NEEDS_REVIEW":
      return "source-changed";
    default:
      return "unverified";
  }
}

/** The subset of `ArticleContent` needed to link to the original version. */
export interface TranslationLanguageVersion extends TranslationContent {
  readonly language: string;
  readonly url?: string | null;
}

/**
 * Finds the original-language version among an article's published versions.
 *
 * Used for the "Read the original" link, which must point at the original
 * language itself rather than at a URL that could negotiate back to the
 * reader's preferred translation.
 */
export function findOriginalContent<T extends TranslationContent>(
  contents: readonly (T | null | undefined)[] | null | undefined,
): T | null {
  if (contents == null) return null;
  for (const content of contents) {
    if (content != null && content.originalLanguage == null) return content;
  }
  return null;
}

/**
 * Everything the article page's reader-facing translation UI decides about the
 * language version on screen.
 *
 * Built once per render from the hydration-stable displayed row so the credit
 * line, the freshness notice, and the authorized actions cannot disagree with
 * each other or flip independently during hydration.
 */
export interface ArticleTranslationPresentation {
  /** Who the reader is told produced this version. */
  readonly credit: TranslationCredit;
  /** Whether to warn that this version may be behind its original. */
  readonly freshness: TranslationFreshness | null;
  /** Canonical URL of the original-language version, for "Read the original". */
  readonly originalUrl: string | null;
  /** Same destination as a local path, for client-side navigation. */
  readonly originalPath: string | null;
  /** Translation editor for the displayed language, for authorized viewers. */
  readonly editTranslationHref: string | null;
  /**
   * Whether the generic "Edit" action opens the *original* rather than what is
   * on screen, so the menu can say so instead of offering two edit items that
   * look interchangeable.
   */
  readonly editTargetIsOriginal: boolean;
}

export interface ArticleTranslationPresentationInput {
  /** The language version being displayed, or nothing while it loads. */
  readonly content: TranslationLanguageVersion | null | undefined;
  /** Every published version, used to resolve the original's URL. */
  readonly allContents:
    | readonly (TranslationLanguageVersion | null | undefined)[]
    | null
    | undefined;
  readonly article: TranslationArticleAuthor;
  /** `/@user/2026/slug` for a local article, `null` for a remote one. */
  readonly articleBase: string | null;
  /** Canonical article URL, used when the original row is not in the set. */
  readonly articleUrl?: string | null;
  readonly viewerCanManageTranslations?: boolean | null;
}

/**
 * The path to hand a client-side navigation, or `null` when the destination is
 * not this article on this site.
 *
 * A remote article's canonical URL lives on another origin, so navigating to
 * its pathname locally would land on an unrelated page (or a 404); such a link
 * has to be followed as a real one.
 */
function sameArticlePath(
  path: string | null,
  articleBase: string | null,
): string | null {
  if (path == null || articleBase == null) return null;
  if (path === articleBase || path.startsWith(`${articleBase}/`)) return path;
  // The server interpolates the raw slug into the canonical URL while the
  // route builds its path with `encodeURIComponent`, so the same slug can be
  // spelled two ways (`c++` against `c%2B%2B`). When the decoded forms agree
  // this is still the article's own page; navigate with the spelling the
  // router itself produces.
  return decodePath(path) === decodePath(articleBase) ? articleBase : null;
}

/** Percent-decodes a path, leaving a malformed sequence alone. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Extracts the path of a URL, leaving an already-relative value alone. */
function urlPath(url: string | null): string | null {
  if (url == null) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? url : null;
  }
}

export function articleTranslationPresentation(
  input: ArticleTranslationPresentationInput,
): ArticleTranslationPresentation {
  const content = input.content ?? null;
  const authorAccountIds = articleAuthorAccountIds(input.article);
  const credit: TranslationCredit =
    content == null
      ? { kind: "original" }
      : translationCredit(content, authorAccountIds);
  const freshness = content == null ? null : translationFreshness(content);
  // The original's own canonical URL, never a path that could negotiate back
  // to the reader's preferred translation. The `[lang]` route filters
  // `contents` to one row, so the original is not always in the set; the
  // article's canonical URL is the fallback because the bare route renders the
  // original deterministically.
  const originalUrl =
    findOriginalContent(input.allContents)?.url ?? input.articleUrl ?? null;
  // An automatic translation that is still running has no translated text to
  // edit, and the management page (which lists published versions and private
  // drafts) has no row for it, so the editor link would open nothing.
  const translated =
    content != null &&
    content.originalLanguage != null &&
    !content.beingTranslated;
  const editTranslationHref =
    translated && input.articleBase != null && input.viewerCanManageTranslations
      ? `${input.articleBase}/translations?language=${encodeURIComponent(
          content!.language,
        )}`
      : null;
  return {
    credit,
    freshness,
    originalUrl,
    originalPath: sameArticlePath(urlPath(originalUrl), input.articleBase),
    editTranslationHref,
    editTargetIsOriginal: content != null && content.originalLanguage != null,
  };
}

/** One entry in the article's language menu. */
export interface LanguageMenuRow {
  readonly language: string;
  /** `null` for the version being read, which is not a link to itself. */
  readonly href: string | null;
  readonly current: boolean;
  /** An automatic translation that has not finished yet. */
  readonly beingTranslated: boolean;
  /**
   * How to describe this version. A row whose automatic translation is still
   * running reads as `translating`, because an unfinished job has no credit a
   * reader could evaluate.
   */
  readonly credit: TranslationCredit;
  /** `null` for the original, and while the version is being translated. */
  readonly freshness: TranslationFreshness | null;
}

export interface LanguageMenuInput {
  readonly allContents:
    | readonly (TranslationLanguageVersion | null | undefined)[]
    | null
    | undefined;
  readonly article: TranslationArticleAuthor;
  /** Language of the version being read, so its row is marked instead of linked. */
  readonly currentLanguage?: string | null;
  /** `/@user/2026/slug`, used when a row has no server-assigned URL yet. */
  readonly articleBase: string | null;
}

export function articleLanguageMenuRows(
  input: LanguageMenuInput,
): LanguageMenuRow[] {
  const authorAccountIds = articleAuthorAccountIds(input.article);
  const rows: LanguageMenuRow[] = [];
  for (const content of input.allContents ?? []) {
    // solid-relay can republish a transiently incomplete store snapshot inside
    // `batch()`, surfacing `undefined` rows; skip them rather than throwing.
    if (content == null) continue;
    const current = content.language === input.currentLanguage;
    const beingTranslated = content.beingTranslated === true;
    rows.push({
      language: content.language,
      // A being-translated placeholder has no server-assigned URL yet; fall
      // back to the canonical `/{language}` segment, where the placeholder UI
      // renders, instead of an empty href.
      href: current
        ? null
        : (content.url ??
          (input.articleBase == null
            ? null
            : `${input.articleBase}/${encodeURIComponent(content.language)}`)),
      current,
      beingTranslated,
      credit: translationCredit(content, authorAccountIds),
      freshness: translationFreshness(content),
    });
  }
  return rows;
}

export interface AutomaticTranslationLocalesInput {
  readonly allowLlmTranslation?: boolean | null;
  /** The viewer's preferred locales, in order. */
  readonly viewerLocales?: readonly string[] | null;
  readonly articleLanguage?: string | null;
  readonly currentLanguage?: string | null;
  readonly publishedLanguages: readonly string[];
  /**
   * Restricts a tag to the application's supported content locales, so a link
   * is never offered for a language the `[lang]` route would 404 on.
   */
  readonly normalizeLocale: (locale: string) => string | undefined;
}

/**
 * Two tags name the same translation output when their maximized forms agree
 * on both `language` and `script`, so `en-US`/`en-GB` collapse while
 * `zh-CN`/`zh-TW` (Simplified vs. Traditional) stay distinct. The same rule
 * lives in the `requestArticleTranslation` mutation.
 */
function languageScript(locale: string | null | undefined): string | null {
  if (locale == null) return null;
  try {
    const max = new Intl.Locale(locale).maximize();
    return `${max.language}-${max.script}`;
  } catch {
    return locale;
  }
}

/**
 * Viewer locales that have no published version yet and could be filled by a
 * new automatic translation.
 *
 * These are offered separately from the published versions, because following
 * one starts a machine translation rather than opening something someone has
 * already published.
 */
export function automaticTranslationLocales(
  input: AutomaticTranslationLocalesInput,
): string[] {
  if (!input.allowLlmTranslation) return [];
  const locales = input.viewerLocales;
  if (locales == null || locales.length === 0) return [];
  const existing = new Set(input.publishedLanguages.map(languageScript));
  const articleScript = languageScript(input.articleLanguage);
  const currentScript = languageScript(input.currentLanguage);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const locale of locales) {
    const normalized = input.normalizeLocale(locale);
    if (normalized == null) continue;
    const script = languageScript(normalized);
    if (script == null) continue;
    if (script === articleScript) continue;
    if (script === currentScript) continue;
    if (existing.has(script)) continue;
    if (seen.has(script)) continue;
    seen.add(script);
    result.push(normalized);
  }
  return result;
}

/**
 * The subset of `PostContentTranslation` needed to credit a remote post's
 * language version.
 *
 * `kind`, `freshness`, and `type` are plain strings for the same reason as in
 * {@link TranslationContent}: an enum member added later falls through to the
 * neutral branches instead of being labelled by accident.
 */
export interface RemoteTranslationContent {
  readonly kind: string;
  readonly freshness: string;
  readonly byAuthor: boolean;
  readonly translators: readonly {
    readonly id: string;
    readonly handle: string;
    readonly type: string;
  }[];
}

const HUMAN_ACTOR_TYPES: ReadonlySet<string> = new Set([
  "PERSON",
  "ORGANIZATION",
  "GROUP",
]);

/**
 * Classifies a remote post's language version from its FEP-22cd metadata.
 *
 * The publisher's claim is shown as it was made: `kind` decides the wording,
 * so a translator this server cannot resolve never turns human work into
 * machine output. A version whose producers are unknown is not credited to
 * anyone, and "an unavailable account" is never used, because an unresolved
 * remote actor is not known to be a deleted one.
 */
export function remoteTranslationCredit(
  translation: RemoteTranslationContent,
): TranslationCredit {
  switch (translation.kind) {
    case "MACHINE":
      return { kind: "automatic" };
    case "HUMAN":
    case "MACHINE_REVIEWED": {
      const assistance: TranslationAssistance =
        translation.kind === "MACHINE_REVIEWED" ? "llm" : "none";
      if (translation.byAuthor) return { kind: "author", assistance };
      const person = translation.translators.find((actor) =>
        HUMAN_ACTOR_TYPES.has(actor.type),
      );
      if (person == null) return { kind: "unknown" };
      return {
        kind: "account",
        assistance,
        account: {
          id: person.id,
          // The label prefixes `@`, and a remote translator needs the full
          // handle to be unambiguous.
          username: person.handle.replace(/^@/, ""),
          handle: person.handle,
        },
      };
    }
    default:
      return { kind: "unknown" };
  }
}

/**
 * The freshness signal of a remote post's language version. Anything but a
 * claimed `CURRENT` or `SOURCE_CHANGED` is unverified.
 */
export function remoteTranslationFreshness(
  translation: Pick<RemoteTranslationContent, "freshness">,
): TranslationFreshness {
  switch (translation.freshness) {
    case "CURRENT":
      return "current";
    case "SOURCE_CHANGED":
      return "source-changed";
    default:
      return "unverified";
  }
}

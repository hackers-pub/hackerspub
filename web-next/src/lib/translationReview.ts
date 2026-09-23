/**
 * Review state and reopen rules shared by the translation management UI.
 *
 * These live apart from the manager component so they can be exercised
 * without a DOM: they decide whether an editor is told the original moved on,
 * and what provenance a reopened draft inherits, both of which are easy to get
 * subtly wrong and impossible to notice from a screenshot.
 */

export type TranslationReviewState =
  | "CURRENT"
  | "NEEDS_REVIEW"
  | "UNKNOWN_BASELINE";

/**
 * The more serious of two review states, so a language whose draft and
 * published version disagree is presented by whichever of them is behind.
 * A known source change outranks unverifiable freshness, which outranks
 * "reviewed".
 */
export function worseReviewState(
  a: TranslationReviewState,
  b: TranslationReviewState,
): TranslationReviewState {
  if (a === "NEEDS_REVIEW" || b === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  if (a === "UNKNOWN_BASELINE" || b === "UNKNOWN_BASELINE") {
    return "UNKNOWN_BASELINE";
  }
  return "CURRENT";
}

/**
 * The review state the management list shows for one language.
 *
 * A draft created (or reopened) after a source edit starts out `CURRENT`
 * because it captured the newest revision, while the version readers actually
 * see is still behind. Folding the published state in keeps that behind-ness
 * visible instead of letting a fresh draft hide it.
 */
export function translationReviewState(translation: {
  reviewState: TranslationReviewState;
  publishedReviewState?: TranslationReviewState | null;
}): TranslationReviewState {
  return worseReviewState(
    translation.reviewState,
    translation.publishedReviewState ?? "CURRENT",
  );
}

/**
 * Narrows the review state Relay hands us, which also carries
 * `"%future added value"`. An unrecognized state falls back to an unknown
 * baseline: an old client must never present a state it cannot interpret as
 * verified freshness.
 */
export function toTranslationReviewState(
  value: string,
): TranslationReviewState {
  return value === "CURRENT" || value === "NEEDS_REVIEW"
    ? value
    : "UNKNOWN_BASELINE";
}

/**
 * The provenance a reopened draft has to carry so publishing it cannot relabel
 * the work.
 *
 * An automatic or AI-assisted version reopens as `LLM`, so the republished
 * version is still presented as AI-assisted; a legacy version whose history is
 * unknown keeps that uncertainty; anything else is person-supplied. An
 * unrecognized value is treated as unknown rather than being promoted to
 * `HUMAN`, because promoting it would claim a person wrote text nobody can
 * account for.
 */
export function reopenedTranslationProvenance(
  publishedProvenance: string | null | undefined,
): "HUMAN" | "LLM" | "UNKNOWN" {
  switch (publishedProvenance) {
    case "HUMAN":
      return "HUMAN";
    case "LLM":
    case "LLM_REVIEWED":
      return "LLM";
    default:
      return "UNKNOWN";
  }
}

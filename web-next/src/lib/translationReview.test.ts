import assert from "node:assert";
import test from "node:test";

import {
  reopenedTranslationProvenance,
  toTranslationReviewState,
  translationReviewState,
  worseReviewState,
} from "./translationReview.ts";

test("a reopened draft cannot hide a published version that is behind", () => {
  // Reopening a published language captures the *current* source revision, so
  // the new draft reads CURRENT while readers still see the stale version.
  // The list has to keep showing the published version's state.
  assert.equal(
    translationReviewState({
      reviewState: "CURRENT",
      publishedReviewState: "NEEDS_REVIEW",
    }),
    "NEEDS_REVIEW",
  );
  assert.equal(
    translationReviewState({
      reviewState: "CURRENT",
      publishedReviewState: "UNKNOWN_BASELINE",
    }),
    "UNKNOWN_BASELINE",
  );
});

test("an unpublished language is judged on its draft alone", () => {
  assert.equal(
    translationReviewState({
      reviewState: "NEEDS_REVIEW",
      publishedReviewState: null,
    }),
    "NEEDS_REVIEW",
  );
  assert.equal(translationReviewState({ reviewState: "CURRENT" }), "CURRENT");
});

test("a known source change outranks unverifiable freshness", () => {
  assert.equal(
    worseReviewState("UNKNOWN_BASELINE", "NEEDS_REVIEW"),
    "NEEDS_REVIEW",
  );
  assert.equal(
    worseReviewState("CURRENT", "UNKNOWN_BASELINE"),
    "UNKNOWN_BASELINE",
  );
  assert.equal(worseReviewState("CURRENT", "CURRENT"), "CURRENT");
});

test("an uninterpretable review state is never presented as verified", () => {
  assert.equal(toTranslationReviewState("CURRENT"), "CURRENT");
  assert.equal(toTranslationReviewState("NEEDS_REVIEW"), "NEEDS_REVIEW");
  for (const value of ["UNKNOWN_BASELINE", "%future added value", ""]) {
    assert.equal(toTranslationReviewState(value), "UNKNOWN_BASELINE");
  }
});

test("reopening preserves how the published version was produced", () => {
  // Publishing a reopened draft must not relabel an automatic or AI-assisted
  // version as person-supplied work.
  assert.equal(reopenedTranslationProvenance("HUMAN"), "HUMAN");
  assert.equal(reopenedTranslationProvenance("LLM"), "LLM");
  assert.equal(reopenedTranslationProvenance("LLM_REVIEWED"), "LLM");
  assert.equal(reopenedTranslationProvenance("UNKNOWN"), "UNKNOWN");
  // An unrecognized or missing provenance stays uncertain rather than being
  // promoted to a claim that a person wrote it.
  assert.equal(reopenedTranslationProvenance(null), "UNKNOWN");
  assert.equal(reopenedTranslationProvenance(undefined), "UNKNOWN");
  assert.equal(reopenedTranslationProvenance("%future added value"), "UNKNOWN");
});

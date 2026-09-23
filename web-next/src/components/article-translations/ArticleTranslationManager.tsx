import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { graphql } from "relay-runtime";
import { HtmlContent } from "~/components/HtmlContent.tsx";
import { LanguageName } from "~/components/LanguageName.tsx";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { msg, useLingui } from "~/lib/i18n/macro.ts";
import { diffLines } from "~/lib/lineDiff.ts";
import {
  reopenedTranslationProvenance,
  type TranslationReviewState,
  translationReviewState,
} from "~/lib/translationReview.ts";
import type { ArticleTranslationManagerSaveMutation } from "./__generated__/ArticleTranslationManagerSaveMutation.graphql.ts";
import type { ArticleTranslationManagerDeleteMutation } from "./__generated__/ArticleTranslationManagerDeleteMutation.graphql.ts";
import type { ArticleTranslationManagerPublishMutation } from "./__generated__/ArticleTranslationManagerPublishMutation.graphql.ts";
import type { ArticleTranslationManagerAcknowledgeMutation } from "./__generated__/ArticleTranslationManagerAcknowledgeMutation.graphql.ts";

const SaveMutation = graphql`
  mutation ArticleTranslationManagerSaveMutation(
    $input: SaveArticleTranslationDraftInput!
  ) {
    saveArticleTranslationDraft(input: $input) {
      __typename
      ... on SaveArticleTranslationDraftPayload {
        draft {
          uuid
          language
          title
          content
          revision
          publishedRevision
          provenance
          publicationState
          reviewState
          translator {
            id
            username
          }
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

const DeleteMutation = graphql`
  mutation ArticleTranslationManagerDeleteMutation(
    $input: DeleteArticleTranslationDraftInput!
  ) {
    deleteArticleTranslationDraft(input: $input) {
      __typename
      ... on DeleteArticleTranslationDraftPayload {
        deletedDraftId
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

// The publish payload deliberately re-reads every field the reader-facing
// article page renders for a language version. Relay normalizes these rows by
// `id`, so republishing a translation patches the records the article route
// already holds instead of leaving a stale title, body, credit, freshness or
// "translating…" placeholder behind.
const PublishMutation = graphql`
  mutation ArticleTranslationManagerPublishMutation(
    $input: PublishArticleTranslationInput!
  ) {
    publishArticleTranslation(input: $input) {
      __typename
      ... on PublishArticleTranslationPayload {
        language
        article {
          id
          contents(includeBeingTranslated: true) {
            id
            language
            title
            content
            toc
            url
            originalLanguage
            beingTranslated
            provenance
            reviewState
            translator {
              id
              username
              handle
            }
          }
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

const AcknowledgeMutation = graphql`
  mutation ArticleTranslationManagerAcknowledgeMutation(
    $input: AcknowledgeArticleTranslationSourceInput!
  ) {
    acknowledgeArticleTranslationSource(input: $input) {
      __typename
      ... on AcknowledgeArticleTranslationSourcePayload {
        translationDraft {
          uuid
          reviewState
        }
        content {
          id
          language
          reviewState
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

// "Published" is also an analytics column heading meaning "publication time",
// and several locales translate it that way. The context keeps this
// publication-state label in its own catalog entry.
const publishedStatusMessage = msg({
  message: "Published",
  context: "publication state",
});

export type TranslationUuid =
  `${string}-${string}-${string}-${string}-${string}`;

// Re-exported so the management pages keep importing the whole translation
// vocabulary from one place; the logic itself lives in a DOM-free module so it
// can be tested directly.
export {
  reopenedTranslationProvenance,
  type TranslationReviewState,
  toTranslationReviewState,
  translationReviewState,
} from "~/lib/translationReview.ts";

/**
 * A message that outlives the editor reload following a write.
 *
 * The kind records what made it true, so a later write can retire exactly the
 * messages it invalidated instead of clearing the panel wholesale.
 */
interface ManagerNotice {
  readonly kind: "reopenCredit" | "refreshFailed";
  readonly message: string;
}

export interface ArticleSourceRevisionView {
  uuid: TranslationUuid;
  title: string;
  content: string;
}

export interface ArticleTranslationView {
  uuid: TranslationUuid;
  language: string;
  title: string;
  content: string;
  revision: number;
  publishedRevision: number | null;
  provenance: string;
  publicationState: string;
  reviewState: TranslationReviewState;
  /**
   * The original as this translation's translator last read it. `null` for an
   * unknown baseline, where no comparison can be shown and the notice has to
   * say that freshness is unverified rather than that the original changed.
   */
  baselineSourceRevision: ArticleSourceRevisionView | null;
  /**
   * The review state of the *published* version of this language, or `null`
   * when the language has never been published.
   *
   * It is tracked separately because the two can disagree: a draft created
   * after a source edit starts out current while the version readers actually
   * see is still behind, and acknowledging has to be offered for the version
   * that is behind.
   */
  publishedReviewState: TranslationReviewState | null;
  /** The published version's own reviewed baseline, for that comparison. */
  publishedBaselineSourceRevision: ArticleSourceRevisionView | null;
  translatorUsername: string | null;
  contentHtml: string;
}

/**
 * A published language version that has no private draft: a legacy
 * translation, or one whose draft was deleted after publication. The
 * management list has to show it, because its credited translator is notified
 * when the original changes and an authorized editor must be able to review it
 * without first recreating a draft.
 */
export interface PublishedTranslationView {
  language: string;
  reviewState: TranslationReviewState;
  /**
   * The original as this published version was last reviewed against, so the
   * comparison works here too. `null` only for an unknown baseline, which is
   * also the only state in which `reviewState` can be `UNKNOWN_BASELINE`.
   */
  baselineSourceRevision: ArticleSourceRevisionView | null;
  translatorUsername: string | null;
  automatic: boolean;
  /**
   * The published text and credit, so reopening this language starts from what
   * readers currently see instead of from an empty editor.
   */
  title: string;
  rawContent: string;
  provenance: string | null;
  translatorId: TranslationUuid | null;
}

export interface ArticleTranslationManagerProps {
  scope: { articleDraftId: TranslationUuid } | { sourceId: TranslationUuid };
  originalTitle: string;
  originalLanguage: string | null;
  /**
   * The original's current snapshot. Publishing and acknowledging both name
   * it, so the server records what the editor actually rendered rather than
   * assuming the reviewer saw the newest original.
   */
  currentSourceRevision: ArticleSourceRevisionView | null;
  translations: ArticleTranslationView[];
  /**
   * Published languages with no private draft, listed after the drafts. They
   * are read-only here: **Add translation** creates the draft that makes one
   * editable.
   */
  publishedOnlyTranslations?: PublishedTranslationView[];
  canPublishIndependently: boolean;
  onChanged: () => void | Promise<void>;
  /**
   * Language to open on first load, from the article page's
   * **Edit this translation** action. Already canonicalized by the caller;
   * a language with neither a draft nor a published version is ignored.
   */
  initialLanguage?: string | null;
  /**
   * Called after a change that readers can see (publishing a translation, or
   * acknowledging a source revision) with the language that changed, so the
   * caller can refresh the article page. Saving or deleting a private draft
   * deliberately does not call it: a draft save must never move the
   * reader-facing notice.
   */
  onPublicChange?: (language: string) => void | Promise<void>;
}

export function ArticleTranslationManager(
  props: ArticleTranslationManagerProps,
) {
  const { i18n, t } = useLingui();
  const [saveMutation, saving] =
    createMutation<ArticleTranslationManagerSaveMutation>(SaveMutation);
  const [deleteMutation, deleting] =
    createMutation<ArticleTranslationManagerDeleteMutation>(DeleteMutation);
  const [publishMutation, publishing] =
    createMutation<ArticleTranslationManagerPublishMutation>(PublishMutation);
  const [acknowledgeMutation, acknowledging] =
    createMutation<ArticleTranslationManagerAcknowledgeMutation>(
      AcknowledgeMutation,
    );
  const [selectedUuid, setSelectedUuid] = createSignal<
    TranslationUuid | undefined
  >();
  // A published language with no private draft is selected by language rather
  // than by draft id; the two selections are mutually exclusive.
  const [selectedPublished, setSelectedPublished] = createSignal<
    string | undefined
  >();
  const [newLanguage, setNewLanguage] = createSignal<Intl.Locale | undefined>();
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  // Kept apart from `error`, which the selection effect below clears whenever
  // the editor reloads: these messages have to survive the selection change
  // and the list reload that follow a reopen or a publish. The kind is what
  // lets a later success retire the message it actually invalidated.
  const [notice, setNotice] = createSignal<ManagerNotice | undefined>();
  // True while a mutation's follow-up reload is in flight, so the editor is
  // not reset under the user's fingers between the save echo and the refetch.
  const [reloading, setReloading] = createSignal(false);
  const [showComparison, setShowComparison] = createSignal(false);
  const newLanguageCode = () => newLanguage()?.baseName;
  // The original language and every language that already has a draft cannot
  // be added again: existing drafts are opened from the list instead.
  const unavailableLanguages = () => {
    const codes = new Set<string>();
    if (props.originalLanguage != null) {
      codes.add(new Intl.Locale(props.originalLanguage).baseName);
    }
    for (const translation of props.translations) {
      codes.add(new Intl.Locale(translation.language).baseName);
    }
    return [...codes].map((code) => new Intl.Locale(code));
  };

  const selected = () =>
    props.translations.find((t) => t.uuid === selectedUuid());
  const publishedOnly = () => props.publishedOnlyTranslations ?? [];
  const selectedPublishedTranslation = () =>
    publishedOnly().find((t) => t.language === selectedPublished());

  const selectDraft = (uuid: TranslationUuid | undefined) => {
    setNotice(undefined);
    setSelectedPublished(undefined);
    setSelectedUuid(uuid);
  };
  const selectPublished = (language: string) => {
    setNotice(undefined);
    setSelectedUuid(undefined);
    setSelectedPublished(language);
  };

  // Open the language the article page's **Edit this translation** action
  // asked for. Keyed by the requested language rather than by a single
  // "applied" flag, so navigating from `?language=ko` to `?language=ja` still
  // works while a background reload cannot pull the selection away from a
  // language the editor has since chosen by hand.
  let appliedInitialLanguage: string | null = null;
  createEffect(() => {
    const requested = props.initialLanguage;
    if (requested == null || requested === appliedInitialLanguage) return;
    const sameLanguage = (candidate: string) => {
      try {
        return (
          new Intl.Locale(candidate).baseName ===
          new Intl.Locale(requested).baseName
        );
      } catch {
        return candidate === requested;
      }
    };
    // Exact first, because `Intl.Locale` canonicalization merges distinct
    // supported keys: `tw` and `ak` both carry the base name `ak`, and an
    // article can hold a translation under either, so matching on the base
    // name alone can open the wrong language.
    const draft =
      props.translations.find(
        (translation) => translation.language === requested,
      ) ??
      props.translations.find((translation) =>
        sameLanguage(translation.language),
      );
    const published =
      publishedOnly().find(
        (translation) => translation.language === requested,
      ) ??
      publishedOnly().find((translation) => sameLanguage(translation.language));
    // Nothing to open yet: the list may still be loading, so leave the request
    // outstanding rather than consuming it against an empty list.
    if (draft == null && published == null) return;
    appliedInitialLanguage = requested;
    if (draft != null) selectDraft(draft.uuid);
    else selectPublished(published!.language);
  });

  // Load the selected translation into the editor. Switching languages resets
  // the fields, but the unsaved text of the previously selected language is
  // intentionally not silently kept: each language has its own saved draft.
  createEffect(() => {
    selectedPublished();
    const translation = selected();
    setTitle(translation?.title ?? "");
    setContent(translation?.content ?? "");
    setError(undefined);
    setShowComparison(false);
  });

  const scopeInput = () =>
    "articleDraftId" in props.scope
      ? { articleDraftId: props.scope.articleDraftId }
      : { sourceId: props.scope.sourceId };

  const refresh = async () => {
    setReloading(true);
    try {
      await props.onChanged();
    } finally {
      setReloading(false);
    }
  };

  /**
   * Reloads the list and then lets the caller refresh anything readers see.
   * Used only by publishing and by acknowledging a revision; a draft save or
   * delete changes nothing public, so it uses {@link refresh}.
   */
  const refreshPublic = async (language: string) => {
    setReloading(true);
    try {
      // Both refreshes always run. Awaiting them in sequence meant a failed
      // list reload skipped the article refresh entirely, which is the one
      // that readers can see; they are independent refetches, so neither has
      // to wait for the other. The first failure is reported once both are
      // done.
      const results = await Promise.allSettled([
        props.onChanged(),
        props.onPublicChange?.(language),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure != null) throw failure.reason;
    } finally {
      setReloading(false);
    }
  };

  /**
   * Runs the post-write refresh and tells the editor when it fails.
   *
   * The write itself has already succeeded by this point, so this is not an
   * error: it only means this tab may still be showing the old state. The
   * message goes to `notice` rather than `error` because the list reload
   * inside `refreshPublic` clears `error` on its way past.
   *
   * @param published Whether the write replaced the public version. A
   *                  successful publish retires the reopen credit notice too,
   *                  because its promise that the published version keeps its
   *                  original credit has just stopped being true.
   */
  const refreshPublicOrNotify = (language: string, published: boolean) => {
    void refreshPublic(language).then(
      () => {
        setNotice((current) =>
          current == null ||
          current.kind === "refreshFailed" ||
          (published && current.kind === "reopenCredit")
            ? undefined
            : current,
        );
      },
      (cause: unknown) => {
        console.error("Failed to refresh after a public change:", cause);
        setNotice({
          kind: "refreshFailed",
          message: t`This change is saved, but the translation list or the article page could not be refreshed. Reload to see it.`,
        });
      },
    );
  };

  const busy = () =>
    saving() || deleting() || publishing() || acknowledging() || reloading();

  /** Whether the editor holds translation text that has not been saved yet. */
  const dirty = () => {
    const translation = selected();
    if (translation == null) return false;
    return title() !== translation.title || content() !== translation.content;
  };

  const publishedLabel = () => i18n._(publishedStatusMessage);

  const reviewStateLabel = (state: TranslationReviewState) =>
    state === "NEEDS_REVIEW"
      ? t`Needs review`
      : state === "UNKNOWN_BASELINE"
        ? t`Freshness unverified`
        : t`Reviewed`;

  // The comparison the translator has to read: what they were last shown on
  // the left, the current original on the right.
  /**
   * What the review controls act on for the current selection: the language,
   * how far behind it is, the baseline to compare against, and the draft
   * revision to guard with (absent when the language has no draft).
   *
   * When a draft and its published version disagree, the published version
   * wins: it is what readers see, and acknowledging advances both.
   */
  const reviewTarget = createMemo(() => {
    const translation = selected();
    const published =
      translation == null ? selectedPublishedTranslation() : undefined;
    if (translation == null && published == null) return undefined;
    // Every side that is behind contributes its own baseline. Acknowledging
    // advances the draft and the published version together, so the reviewer
    // has to be shown everything that has changed since *either* of them: with
    // only one of the two rendered, a draft based on an older revision than
    // the published version would be marked current over changes nobody saw.
    // The two baselines cannot be ordered against each other (snapshot
    // timestamps are transaction start times), so both are rendered rather
    // than guessing which is older.
    const sides: {
      key: "published" | "draft";
      baseline: ArticleSourceRevisionView | null;
    }[] =
      translation == null
        ? [{ key: "published", baseline: published!.baselineSourceRevision }]
        : [
            ...(translation.publishedReviewState != null &&
            translation.publishedReviewState !== "CURRENT"
              ? [
                  {
                    key: "published" as const,
                    baseline: translation.publishedBaselineSourceRevision,
                  },
                ]
              : []),
            ...(translation.reviewState !== "CURRENT"
              ? [
                  {
                    key: "draft" as const,
                    baseline: translation.baselineSourceRevision,
                  },
                ]
              : []),
          ];
    const seen = new Set<string>();
    const baselines: {
      key: "published" | "draft";
      baseline: ArticleSourceRevisionView;
    }[] = [];
    let unknownBaseline = false;
    for (const side of sides) {
      if (side.baseline == null) {
        unknownBaseline = true;
        continue;
      }
      if (seen.has(side.baseline.uuid)) continue;
      seen.add(side.baseline.uuid);
      baselines.push({ key: side.key, baseline: side.baseline });
    }
    return {
      language: translation?.language ?? published!.language,
      state:
        translation == null
          ? published!.reviewState
          : translationReviewState(translation),
      baselines,
      unknownBaseline,
      draftRevision: (translation?.revision ?? null) as number | null,
    };
  });

  const comparison = createMemo(() => {
    const current = props.currentSourceRevision;
    const target = reviewTarget();
    if (current == null || target == null) return undefined;
    return {
      current,
      unknownBaseline: target.unknownBaseline,
      sections: target.baselines.map((side) => ({
        key: side.key,
        baseline: side.baseline,
        body: diffLines(side.baseline.content, current.content),
      })),
    };
  });

  const handleAcknowledge = () => {
    const target = reviewTarget();
    const current = props.currentSourceRevision;
    if (target == null || current == null) return;
    // Snapshot the language before the mutation so the follow-up refresh names
    // what was acknowledged, not whatever the list has selected by the time
    // the response arrives.
    const acknowledgedLanguage = target.language;
    setError(undefined);
    acknowledgeMutation({
      variables: {
        input: {
          ...scopeInput(),
          language: target.language,
          // The revision this editor actually rendered, not whatever is newest
          // on the server: if the original moved while the comparison was
          // open, the translation must stay in need of review.
          sourceRevisionId: current.uuid,
          // Absent for a published language with no draft: there is no draft
          // revision to guard against.
          translationDraftRevision: target.draftRevision,
        },
      },
      onCompleted(response) {
        const payload = response.acknowledgeArticleTranslationSource;
        if (
          payload.__typename === "AcknowledgeArticleTranslationSourcePayload"
        ) {
          setShowComparison(false);
          refreshPublicOrNotify(acknowledgedLanguage, false);
          return;
        }
        if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else if (payload.__typename === "InvalidInputError") {
          setError(t`There is nothing to review for this language.`);
        } else {
          setError(t`You may not have permission to review this translation.`);
        }
      },
      onError() {
        setError(t`Failed to record the review.`);
      },
    });
  };

  const handleSave = (
    revision?: number,
    afterSave?: (draft: { uuid: TranslationUuid; revision: number }) => void,
  ) => {
    const language = selected()?.language ?? newLanguageCode();
    if (language == null) return;
    setError(undefined);
    saveMutation({
      variables: {
        input: {
          ...scopeInput(),
          ...(revision != null && selectedUuid() != null
            ? { id: selectedUuid(), revision }
            : {}),
          language,
          title: title(),
          content: content(),
        },
      },
      onCompleted(response) {
        const payload = response.saveArticleTranslationDraft;
        if (payload.__typename === "SaveArticleTranslationDraftPayload") {
          selectDraft(payload.draft.uuid);
          setNewLanguage(undefined);
          if (afterSave != null) {
            afterSave({
              uuid: payload.draft.uuid,
              revision: payload.draft.revision,
            });
            return;
          }
          void refresh();
          return;
        }
        if (payload.__typename === "InvalidInputError") {
          setError(t`That language is not available or the input is invalid.`);
        } else if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else {
          setError(t`You may not have permission to save this translation.`);
        }
      },
      onError() {
        setError(t`Failed to save the translation.`);
      },
    });
  };

  /**
   * Reopens a published language that has no private draft, seeding the draft
   * with the published title, body, credited translator and provenance.
   *
   * Creating a blank draft here would be worse than offering nothing: the
   * create path defaults provenance to `HUMAN` and the translator to the
   * acting individual, so publishing it would relabel an automatic or legacy
   * version as person-supplied work and move someone else's credit.
   */
  const handleReopenPublished = (
    translation: PublishedTranslationView,
    // Set on the retry described below, where the credit could not be kept.
    dropTranslator = false,
  ) => {
    setError(undefined);
    setTitle(translation.title);
    setContent(translation.rawContent);
    const keepsCredit = !dropTranslator && translation.translatorId != null;
    saveMutation({
      variables: {
        input: {
          ...scopeInput(),
          language: translation.language,
          title: translation.title,
          content: translation.rawContent,
          provenance: reopenedTranslationProvenance(translation.provenance),
          ...(keepsCredit ? { translatorId: translation.translatorId } : {}),
        },
      },
      onCompleted(response) {
        const payload = response.saveArticleTranslationDraft;
        if (payload.__typename === "SaveArticleTranslationDraftPayload") {
          selectDraft(payload.draft.uuid);
          if (dropTranslator) {
            setNotice({
              kind: "reopenCredit",
              message: t`The credited translator can no longer edit this article, so this draft is credited to you. The published version keeps its original credit until you publish.`,
            });
          }
          // A private draft is not public yet, so this is a plain reload.
          void refresh();
          return;
        }
        if (payload.__typename === "InvalidInputError") {
          // The server only accepts a translator who can still act for the
          // owning account, so a credited member who has left the
          // organization is rejected. Their published credit stays as it is;
          // the reopened draft has to be credited to whoever is editing now.
          if (payload.inputPath === "translatorId" && keepsCredit) {
            handleReopenPublished(translation, true);
            return;
          }
          setError(t`That language is not available or the input is invalid.`);
        } else if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else {
          setError(t`You may not have permission to save this translation.`);
        }
      },
      onError() {
        setError(t`Failed to save the translation.`);
      },
    });
  };

  const handleDelete = () => {
    const translation = selected();
    if (translation == null) return;
    deleteMutation({
      variables: {
        input: { id: translation.uuid, revision: translation.revision },
      },
      onCompleted(response) {
        const payload = response.deleteArticleTranslationDraft;
        if (payload.__typename === "DeleteArticleTranslationDraftPayload") {
          selectDraft(undefined);
          void refresh();
          return;
        }
        if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else if (payload.__typename === "InvalidInputError") {
          setError(t`Failed to delete the translation draft.`);
        } else {
          setError(t`You may not have permission to delete this translation.`);
        }
      },
      onError() {
        setError(t`Failed to delete the translation draft.`);
      },
    });
  };

  const publish = (
    id: TranslationUuid,
    revision: number,
    // Read by the caller before any asynchronous step, so publishing records
    // the revision this editor rendered rather than whatever is newest by the
    // time the mutation runs.
    sourceRevisionId: TranslationUuid | null,
  ) => {
    setError(undefined);
    publishMutation({
      variables: { input: { id, revision, sourceRevisionId } },
      onCompleted(response) {
        const payload = response.publishArticleTranslation;
        if (payload.__typename === "PublishArticleTranslationPayload") {
          refreshPublicOrNotify(payload.language, true);
          return;
        }
        if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else if (payload.__typename === "InvalidInputError") {
          setError(t`Failed to publish the translation.`);
        } else {
          setError(t`You may not have permission to publish this translation.`);
        }
        void refresh();
      },
      onError() {
        setError(t`Failed to publish the translation.`);
      },
    });
  };

  const handlePublish = () => {
    const translation = selected();
    if (translation == null) return;
    // Publishing from this editor means "reviewed against the original shown
    // here". A stale editor therefore publishes a stale baseline and the
    // translation correctly stays in need of review.
    const reviewed = props.currentSourceRevision?.uuid ?? null;
    // Publishing must not discard unsaved editor text: persist it first and
    // publish the revision that save returned.
    const dirty =
      title() !== translation.title || content() !== translation.content;
    if (dirty) {
      handleSave(translation.revision, (saved) => {
        publish(saved.uuid, saved.revision, reviewed);
      });
    } else {
      publish(translation.uuid, translation.revision, reviewed);
    }
  };

  /**
   * The **Original changed** notice, shared by the draft editor and the
   * read-only panel for a published language that has no draft. An unknown
   * baseline gets its own wording and shows only the current original: there
   * is no earlier version to diff against, and claiming a specific change
   * would be a fabrication.
   */
  const reviewBanner = (reviewState: TranslationReviewState) => (
    <div class="mb-4 rounded-md border border-border p-3">
      <div class="flex flex-wrap items-center gap-2">
        <Badge
          variant={reviewState === "NEEDS_REVIEW" ? "warning" : "secondary"}
        >
          {reviewStateLabel(reviewState)}
        </Badge>
        <p class="text-sm">
          {reviewState === "NEEDS_REVIEW"
            ? t`The original has changed since this translation was last reviewed.`
            : t`No baseline was recorded for this translation, so its freshness cannot be verified.`}
        </p>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <Show when={props.currentSourceRevision != null}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowComparison(!showComparison())}
          >
            {showComparison() ? t`Hide source changes` : t`View source changes`}
          </Button>
          {/* Acknowledging says the translated text needs no change, and it
              reloads from the server afterwards, so it must not be reachable
              while the editor holds unsaved text: it would both contradict
              itself and discard that text. */}
          <Button
            size="sm"
            variant="outline"
            disabled={busy() || dirty()}
            title={
              dirty()
                ? t`Save or discard your unsaved changes first.`
                : undefined
            }
            onClick={handleAcknowledge}
          >
            {t`No translation changes needed`}
          </Button>
        </Show>
      </div>
      <Show when={showComparison() ? comparison() : undefined} keyed>
        {(diff) => (
          <div class="mt-3 border-t border-border pt-3">
            <Show
              when={diff.sections.length > 0}
              fallback={
                <div>
                  <p class="mb-2 text-xs text-muted-foreground">
                    {t`There is no earlier version of the original to compare with, so only the current original is shown.`}
                  </p>
                  <p class="text-sm font-medium">{diff.current.title}</p>
                  <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">
                    {diff.current.content}
                  </pre>
                </div>
              }
            >
              <Show when={diff.unknownBaseline}>
                <p class="mb-2 text-xs text-muted-foreground">
                  {t`One of these versions has no recorded baseline, so its changes cannot be shown.`}
                </p>
              </Show>
              <For each={diff.sections}>
                {(section) => (
                  <div class="mb-3 last:mb-0">
                    <Show when={diff.sections.length > 1}>
                      <p class="mb-1 text-xs font-medium text-muted-foreground">
                        {section.key === "published"
                          ? t`Since the published version was last reviewed`
                          : t`Since this draft was written`}
                      </p>
                    </Show>
                    <Show
                      when={section.baseline.title !== diff.current.title}
                      fallback={
                        <p class="text-sm">
                          <span class="text-xs text-muted-foreground">
                            {t`Title`}
                          </span>{" "}
                          {diff.current.title}
                        </p>
                      }
                    >
                      <p class="text-sm line-through text-error-foreground">
                        {section.baseline.title}
                      </p>
                      <p class="text-sm text-success-foreground">
                        {diff.current.title}
                      </p>
                    </Show>
                    <div class="mt-2 max-h-80 overflow-auto rounded border border-border">
                      <For each={section.body}>
                        {(line) => (
                          <div
                            classList={{
                              "whitespace-pre-wrap break-words px-2 py-0.5 text-sm font-mono": true,
                              "bg-error text-error-foreground":
                                line.kind === "removed",
                              "bg-success text-success-foreground":
                                line.kind === "added",
                            }}
                          >
                            {/* The +/- prefix is decorative and the colour
                                carries no meaning on its own, so the direction
                                of a changed line has to be spoken. */}
                            <Show when={line.kind !== "unchanged"}>
                              <span class="sr-only">
                                {line.kind === "removed"
                                  ? t`Removed line:`
                                  : t`Added line:`}
                              </span>
                            </Show>
                            <span
                              aria-hidden="true"
                              class="select-none text-muted-foreground"
                            >
                              {line.kind === "removed"
                                ? "- "
                                : line.kind === "added"
                                  ? "+ "
                                  : "  "}
                            </span>
                            {line.text === "" ? "\u00a0" : line.text}
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );

  return (
    <div class="flex flex-col gap-6 lg:flex-row">
      <aside class="lg:w-80 shrink-0">
        <h2 class="mb-2 text-lg font-semibold">{t`Languages`}</h2>
        <ul class="flex flex-col gap-1">
          <For each={props.translations}>
            {(translation) => (
              <li>
                <button
                  type="button"
                  classList={{
                    "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm": true,
                    "border-primary bg-accent":
                      selectedUuid() === translation.uuid,
                    "border-border": selectedUuid() !== translation.uuid,
                  }}
                  onClick={() => selectDraft(translation.uuid)}
                >
                  <span class="font-medium">
                    <LanguageName code={translation.language} />
                  </span>
                  <span class="text-xs text-muted-foreground">
                    <Show
                      when={translation.translatorUsername}
                      fallback={t`No translator credit`}
                    >
                      {(username) => (
                        <>
                          {t`Translated by`} @{username()}
                        </>
                      )}
                    </Show>
                  </span>
                  <span class="text-xs text-muted-foreground">
                    {translation.publicationState === "PUBLISHED"
                      ? publishedLabel()
                      : translation.publicationState ===
                          "PUBLISHED_WITH_CHANGES"
                        ? t`Published; unpublished changes`
                        : t`Not published`}
                  </span>
                  <Show
                    when={translationReviewState(translation) !== "CURRENT"}
                  >
                    <Badge
                      class="mt-1"
                      variant={
                        translationReviewState(translation) === "NEEDS_REVIEW"
                          ? "warning"
                          : "secondary"
                      }
                    >
                      {reviewStateLabel(translationReviewState(translation))}
                    </Badge>
                  </Show>
                </button>
              </li>
            )}
          </For>
          <For each={publishedOnly()}>
            {(translation) => (
              <li>
                <button
                  type="button"
                  classList={{
                    "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm": true,
                    "border-primary bg-accent":
                      selectedPublished() === translation.language,
                    "border-border":
                      selectedPublished() !== translation.language,
                  }}
                  onClick={() => selectPublished(translation.language)}
                >
                  <span class="font-medium">
                    <LanguageName code={translation.language} />
                  </span>
                  <span class="text-xs text-muted-foreground">
                    <Show
                      when={
                        !translation.automatic && translation.translatorUsername
                      }
                      fallback={
                        translation.automatic
                          ? t`Automatic translation`
                          : t`No translator credit`
                      }
                    >
                      {(username) => (
                        <>
                          {t`Translated by`} @{username()}
                        </>
                      )}
                    </Show>
                  </span>
                  <span class="text-xs text-muted-foreground">
                    {publishedLabel()}
                  </span>
                  <Show when={translation.reviewState !== "CURRENT"}>
                    <Badge
                      class="mt-1"
                      variant={
                        translation.reviewState === "NEEDS_REVIEW"
                          ? "warning"
                          : "secondary"
                      }
                    >
                      {reviewStateLabel(translation.reviewState)}
                    </Badge>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>

        <h3 class="mt-6 mb-2 text-sm font-semibold">{t`Add translation`}</h3>
        <div class="flex flex-col gap-2">
          <LanguageSelect
            class="w-full"
            value={newLanguage() ?? null}
            onChange={setNewLanguage}
            exclude={unavailableLanguages()}
          />
          <Button
            size="sm"
            disabled={newLanguage() == null || busy()}
            onClick={() => {
              selectDraft(undefined);
              // Clear synchronously: the createEffect that reloads the editor
              // from `selected()` runs after this handler, so handleSave would
              // otherwise create the new language with the previous
              // translation's title and body.
              setTitle("");
              setContent("");
              handleSave();
            }}
          >
            {t`Add`}
          </Button>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          {t`If a private draft already exists for a language, it opens instead of creating a duplicate.`}
        </p>
      </aside>

      <section class="min-w-0 flex-1">
        {/* Outside both selection gates: a reopen changes the selection and
            then reloads the list, so anything rendered inside them would be
            unmounted before it could be read. */}
        <Show when={notice()}>
          {(notice) => (
            <p class="mb-4 rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground">
              {notice().message}
            </p>
          )}
        </Show>
        <Show keyed when={selectedPublishedTranslation()}>
          {(translation) => (
            <div>
              <h2 class="mb-1 text-lg font-semibold">
                <LanguageName code={translation.language} />
              </h2>
              <p class="mb-4 text-sm text-muted-foreground">
                {t`This language is published without a private draft. Review it here, or start editing to make private changes.`}
              </p>
              <Button
                class="mb-4"
                disabled={busy()}
                onClick={() => handleReopenPublished(translation)}
              >
                {t`Edit this translation`}
              </Button>
              <Show when={translation.reviewState !== "CURRENT"}>
                {reviewBanner(translation.reviewState)}
              </Show>
              <Show when={error()}>
                {(message) => (
                  <p class="mt-3 text-sm text-destructive">{message()}</p>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={selected() != null || newLanguage() != null}
          fallback={
            <Show when={selectedPublishedTranslation() == null}>
              <p class="text-sm text-muted-foreground">
                {t`Select a language to edit its translation.`}
              </p>
            </Show>
          }
        >
          <Show
            when={(() => {
              const target = selected() == null ? undefined : reviewTarget();
              return target != null && target.state !== "CURRENT"
                ? target.state
                : undefined;
            })()}
            keyed
          >
            {(reviewState) => reviewBanner(reviewState)}
          </Show>

          <input
            class="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t`Translated title`}
            value={title()}
            disabled={busy()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />

          <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div class="min-h-[16rem] rounded-md border border-border">
              <MarkdownEditor
                value={content()}
                onInput={setContent}
                ariaLabel={t`Translated body`}
                minHeight="16rem"
                disabled={busy()}
              />
            </div>
            <div class="hidden min-h-[16rem] overflow-auto rounded-md border border-border p-3 xl:block">
              <p class="mb-2 text-xs font-medium text-muted-foreground">
                {t`Original`}
              </p>
              <p class="text-sm">{props.originalTitle}</p>
            </div>
          </div>

          <Show when={selected()?.contentHtml}>
            {(html) => (
              <div class="mt-3 rounded-md border border-border p-3">
                <p class="mb-2 text-xs font-medium text-muted-foreground">
                  {t`Preview`}
                </p>
                <HtmlContent html={html()} class="prose prose-sm max-w-none" />
              </div>
            )}
          </Show>

          <Show when={error()}>
            {(message) => (
              <p class="mt-3 text-sm text-destructive">{message()}</p>
            )}
          </Show>

          <div class="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={
                busy() || title().trim() === "" || content().trim() === ""
              }
              onClick={() => handleSave(selected()?.revision)}
            >
              {t`Save draft`}
            </Button>
            <Show when={props.canPublishIndependently && selected() != null}>
              <Button
                variant="default"
                disabled={
                  busy() || title().trim() === "" || content().trim() === ""
                }
                onClick={handlePublish}
              >
                {selected()?.publicationState === "UNPUBLISHED"
                  ? t`Publish translation`
                  : t`Publish changes`}
              </Button>
            </Show>
            <Show when={selected() != null}>
              <Button
                variant="destructive"
                disabled={busy()}
                onClick={handleDelete}
              >
                {t`Delete draft`}
              </Button>
            </Show>
          </div>
        </Show>
      </section>
    </div>
  );
}

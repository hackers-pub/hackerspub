import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import type {
  NoteDraftData,
  NoteDraftMedia,
  NoteDraftPoll,
  NoteDraftScope,
} from "~/lib/noteDraftStorage.ts";

export interface DraftScopeInput {
  readonly editingNoteId?: string | null;
  readonly replyTargetId?: string | null;
  readonly quotedPostId?: string | null;
  readonly ensureLinkUrl?: string | null;
  readonly initialContent?: string | null;
}

export interface DraftMediaCandidate {
  readonly localId: string;
  readonly previewUrl: string;
  readonly alt: string;
  readonly mediumRelayId?: string;
  readonly uuid?: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly uploading: boolean;
}

export interface NoteDraftDataInput {
  readonly content: string;
  readonly language?: string;
  readonly visibility: PostVisibility;
  readonly quotePolicy: QuotePolicy;
  readonly actingAccountKey: string;
  readonly quotedPostId?: string | null;
  readonly replyTargetId?: string | null;
  readonly ensureLinkUrl?: string | null;
  readonly media: readonly DraftMediaCandidate[];
  readonly poll: NoteDraftPoll;
  readonly updated?: string;
}

export interface DraftScopeTransition {
  readonly previousLoadedKey: string | null;
  readonly formDraftKey: string | null;
  readonly nextKey: string;
  readonly dirty: boolean;
}

export interface ExternalDraftChangeInput {
  readonly sameOrigin: boolean;
  readonly changeKey: string;
  readonly currentKey: string | null;
  readonly dirty: boolean;
}

export type ExternalDraftChangeDecision =
  | "ignore"
  | "load"
  | "preserve-and-resave";

export function getNoteComposerDraftScope(
  input: DraftScopeInput,
): NoteDraftScope | null {
  if (input.editingNoteId) return null;
  if (input.replyTargetId) {
    return { type: "reply", targetId: input.replyTargetId };
  }
  if (input.quotedPostId) {
    return { type: "quote", targetId: input.quotedPostId };
  }
  if (input.ensureLinkUrl) return { type: "link", url: input.ensureLinkUrl };
  const initialContent = input.initialContent?.trim();
  if (initialContent) return { type: "prefill", content: initialContent };
  return { type: "new" };
}

export function createNoteDraftData(
  input: NoteDraftDataInput,
): NoteDraftData {
  return {
    content: input.content,
    language: input.language,
    visibility: input.visibility,
    quotePolicy: input.quotePolicy,
    actingAccountKey: input.actingAccountKey,
    quotedPostId: input.quotedPostId ?? undefined,
    replyTargetId: input.replyTargetId ?? undefined,
    ensureLinkUrl: input.ensureLinkUrl ?? undefined,
    media: input.media.flatMap(toStoredMedium),
    poll: input.poll,
    updated: input.updated ?? new Date().toISOString(),
  };
}

export function toStorableNoteDraftData(
  draft: NoteDraftData,
  dirty: boolean,
): NoteDraftData {
  if (dirty) return draft;
  return {
    ...draft,
    content: "",
    media: [],
    poll: { ...draft.poll, enabled: false },
  };
}

export function hasUnstorableDraftMedia(
  media: readonly DraftMediaCandidate[],
): boolean {
  return media.some((item) =>
    item.uploading ||
    item.uuid == null ||
    item.mediumRelayId == null ||
    (item.url == null && item.previewUrl.startsWith("blob:"))
  );
}

export function shouldPreserveCurrentDraftForm(
  transition: DraftScopeTransition,
): boolean {
  return transition.previousLoadedKey != null &&
    transition.formDraftKey === transition.previousLoadedKey &&
    transition.previousLoadedKey !== transition.nextKey &&
    transition.dirty;
}

export function decideExternalDraftChange(
  input: ExternalDraftChangeInput,
): ExternalDraftChangeDecision {
  if (input.sameOrigin || input.currentKey == null) return "ignore";
  if (input.changeKey !== input.currentKey) return "ignore";
  return input.dirty ? "preserve-and-resave" : "load";
}

function toStoredMedium(
  item: DraftMediaCandidate,
): readonly NoteDraftMedia[] {
  if (
    item.uuid == null ||
    item.mediumRelayId == null ||
    (item.url == null && item.previewUrl.startsWith("blob:"))
  ) {
    return [];
  }
  return [{
    localId: item.localId,
    mediumRelayId: item.mediumRelayId,
    uuid: item.uuid,
    url: item.url ?? item.previewUrl,
    alt: item.alt,
    width: item.width,
    height: item.height,
  }];
}

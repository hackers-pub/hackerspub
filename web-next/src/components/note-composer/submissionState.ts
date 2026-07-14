import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import { ensureLinkInContent } from "~/lib/composerLink.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export interface SubmissionMedium {
  readonly uuid?: string;
  readonly alt: string;
  readonly uploading: boolean;
}

export type SubmissionValidationResult =
  | { readonly ok: true; readonly content: string }
  | {
    readonly ok: false;
    readonly error: "empty-content" | "uploading-media" | "missing-alt";
  };

export interface BuildCreatePostInputOptions {
  readonly content: string;
  readonly ensureLinkUrl?: string | null;
  readonly language?: string;
  readonly fallbackLanguage: string;
  readonly visibility: PostVisibility;
  readonly quotePolicy: QuotePolicy;
  readonly quotedPostId?: string | null;
  readonly replyTargetId?: string | null;
  readonly actingAccountInput: { readonly actingAccountId?: string };
  readonly media: readonly SubmissionMedium[];
}

export interface CreatePostInput {
  readonly content: string;
  readonly language: string;
  readonly visibility: PostVisibility;
  readonly quotePolicy: QuotePolicy;
  readonly quotedPostId: string | null;
  readonly replyTargetId: string | null;
  readonly actingAccountId?: string;
  readonly media: readonly {
    readonly mediumId: Uuid;
    readonly alt: string;
  }[];
}

export interface BuildUpdateNoteInputOptions {
  readonly noteId: string;
  readonly content: string;
  readonly language?: string;
  readonly quotePolicy: QuotePolicy;
  readonly visibility?: PostVisibility | null;
  readonly actingAccountId?: string;
}

export interface UpdateNoteInput {
  readonly noteId: string;
  readonly content: string;
  readonly language: string | null;
  readonly quotePolicy?: QuotePolicy;
  readonly actingAccountId?: string;
}

export interface CreatedNotePathInput {
  readonly uuid: string;
  readonly sourceId?: string | null;
  readonly actor: {
    readonly local: boolean;
    readonly username: string;
    readonly handle: string;
  };
}

export function validateSubmission(
  content: string,
  media: readonly SubmissionMedium[],
): SubmissionValidationResult {
  const normalizedContent = content.trim();
  if (normalizedContent === "") return { ok: false, error: "empty-content" };
  if (media.some((item) => item.uploading)) {
    return { ok: false, error: "uploading-media" };
  }
  if (media.some((item) => item.alt.trim() === "")) {
    return { ok: false, error: "missing-alt" };
  }
  return { ok: true, content: normalizedContent };
}

export function buildCreatePostInput(
  options: BuildCreatePostInputOptions,
): CreatePostInput {
  const content = options.ensureLinkUrl
    ? ensureLinkInContent(options.content.trim(), options.ensureLinkUrl)
    : options.content.trim();
  return {
    content,
    language: options.language ?? options.fallbackLanguage,
    visibility: options.visibility,
    quotePolicy: options.quotePolicy,
    quotedPostId: options.quotedPostId ?? null,
    replyTargetId: options.replyTargetId ?? null,
    ...options.actingAccountInput,
    media: options.media.map((item) => ({
      mediumId: item.uuid! as Uuid,
      alt: item.alt.trim(),
    })),
  };
}

export function buildUpdateNoteInput(
  options: BuildUpdateNoteInputOptions,
): UpdateNoteInput {
  const quotePolicyApplicable = options.visibility === "PUBLIC" ||
    options.visibility === "UNLISTED";
  return {
    noteId: options.noteId,
    content: options.content.trim(),
    language: options.language ?? null,
    ...(quotePolicyApplicable ? { quotePolicy: options.quotePolicy } : {}),
    ...(options.actingAccountId == null
      ? {}
      : { actingAccountId: options.actingAccountId }),
  };
}

export function getNoteInternalHref(note: CreatedNotePathInput): string {
  const actorSegment = note.actor.local
    ? `@${note.actor.username}`
    : encodeHandleSegment(note.actor.handle);
  return `/${actorSegment}/${note.sourceId ?? note.uuid}`;
}

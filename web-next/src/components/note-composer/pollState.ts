import type { NoteDraftPoll } from "~/lib/noteDraftStorage.ts";

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 20;

export interface PollOptionDraft {
  readonly localId: string;
  readonly title: string;
}

export interface PollDraft {
  readonly enabled: boolean;
  readonly title: string;
  readonly multiple: boolean;
  readonly ends: string;
  readonly options: readonly PollOptionDraft[];
}

export interface ValidatedPollInput {
  readonly title: string;
  readonly multiple: boolean;
  readonly options: readonly string[];
  readonly ends: string;
}

export type PollValidationError =
  | "empty-title"
  | "empty-option"
  | "too-few-options"
  | "duplicate-options"
  | "invalid-deadline"
  | "deadline-too-soon";

export type PollValidationResult =
  | { readonly ok: true; readonly value: ValidatedPollInput }
  | { readonly ok: false; readonly error: PollValidationError };

export function createPollDraft(
  now = new Date(),
  createId: () => string = createLocalId,
): PollDraft {
  return {
    enabled: false,
    title: "",
    multiple: false,
    ends: setPollDuration(now, 1),
    options: createMinimumOptions(createId),
  };
}

export function restorePollDraft(
  poll: NoteDraftPoll,
  allowed: boolean,
  now = new Date(),
  createId: () => string = createLocalId,
): PollDraft {
  return {
    enabled: allowed && poll.enabled,
    title: poll.title,
    multiple: poll.multiple,
    ends: poll.ends || setPollDuration(now, 1),
    options: poll.options.length >= MIN_POLL_OPTIONS
      ? poll.options.map((option) => ({ ...option }))
      : createMinimumOptions(createId),
  };
}

export function addPollOption(
  draft: PollDraft,
  createId: () => string = createLocalId,
): PollDraft {
  if (draft.options.length >= MAX_POLL_OPTIONS) return draft;
  return {
    ...draft,
    options: [...draft.options, { localId: createId(), title: "" }],
  };
}

export function removePollOption(
  draft: PollDraft,
  localId: string,
): PollDraft {
  if (draft.options.length <= MIN_POLL_OPTIONS) return draft;
  return {
    ...draft,
    options: draft.options.filter((option) => option.localId !== localId),
  };
}

export function setPollDuration(now: Date, days: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setSeconds(0, 0);
  return formatDateTimeLocal(date);
}

export function validatePollDraft(
  draft: PollDraft,
  now = Date.now(),
): PollValidationResult {
  const title = draft.title.trim();
  if (title === "") return { ok: false, error: "empty-title" };

  const options = draft.options.map((option) => option.title.trim());
  if (options.some((option) => option === "")) {
    return { ok: false, error: "empty-option" };
  }
  if (options.length < MIN_POLL_OPTIONS) {
    return { ok: false, error: "too-few-options" };
  }
  if (new Set(options).size !== options.length) {
    return { ok: false, error: "duplicate-options" };
  }

  const ends = parseDateTimeLocal(draft.ends);
  if (!Number.isFinite(ends.getTime())) {
    return { ok: false, error: "invalid-deadline" };
  }
  if (ends.getTime() - now < 60_000) {
    return { ok: false, error: "deadline-too-soon" };
  }

  return {
    ok: true,
    value: {
      title,
      multiple: draft.multiple,
      options,
      ends: ends.toISOString(),
    },
  };
}

function createMinimumOptions(
  createId: () => string,
): readonly PollOptionDraft[] {
  return Array.from({ length: MIN_POLL_OPTIONS }, () => ({
    localId: createId(),
    title: "",
  }));
}

function createLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
}

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
    pad(date.getDate())
  }T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match == null) return new Date(NaN);
  const [, year, month, day, hours, minutes] = match.map(Number);
  const date = new Date(year, month - 1, day, hours, minutes);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return new Date(NaN);
  }
  return date;
}

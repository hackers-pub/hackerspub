import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";

const STORAGE_PREFIX = "hackerspub:note-draft:v1";
const SCHEMA_VERSION = 1;

export interface NoteDraftMedia {
  readonly localId: string;
  readonly mediumRelayId: string;
  readonly uuid: string;
  readonly url: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
}

export interface NoteDraftPollOption {
  readonly localId: string;
  readonly title: string;
}

export interface NoteDraftPoll {
  readonly enabled: boolean;
  readonly title: string;
  readonly multiple: boolean;
  readonly ends: string;
  readonly options: readonly NoteDraftPollOption[];
}

export interface NoteDraftData {
  readonly content: string;
  readonly language?: string;
  readonly visibility: PostVisibility;
  readonly quotePolicy: QuotePolicy;
  readonly actingAccountKey: string;
  readonly quotedPostId?: string;
  readonly replyTargetId?: string;
  readonly ensureLinkUrl?: string;
  readonly media: readonly NoteDraftMedia[];
  readonly poll: NoteDraftPoll;
  readonly updated: string;
}

export type NoteDraftScope =
  | { readonly type: "new" }
  | { readonly type: "reply"; readonly targetId: string }
  | { readonly type: "quote"; readonly targetId: string }
  | { readonly type: "link"; readonly url: string }
  | { readonly type: "prefill"; readonly content: string };

export interface StoredNoteDraft extends NoteDraftData {
  readonly version: typeof SCHEMA_VERSION;
  readonly scope: NoteDraftScope;
}

export type NoteDraftStorageResult = "ok" | "unavailable" | "empty";

export interface NoteDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function getNoteDraftStorageKey(
  username: string,
  scope: NoteDraftScope,
): string {
  return `${STORAGE_PREFIX}:${encodePart(username)}:${scopeToKey(scope)}`;
}

export function isMeaningfulNoteDraft(draft: NoteDraftData): boolean {
  return (
    draft.content.trim() !== "" || draft.media.length > 0 || draft.poll.enabled
  );
}

export function serializeNoteDraft(
  scope: NoteDraftScope,
  draft: NoteDraftData,
): string | null {
  if (!isMeaningfulNoteDraft(draft)) return null;
  return JSON.stringify({
    version: SCHEMA_VERSION,
    scope,
    ...draft,
  } satisfies StoredNoteDraft);
}

export function parseNoteDraft(raw: string | null): StoredNoteDraft | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== SCHEMA_VERSION) return null;
  const scope = parseScope(value.scope);
  if (scope == null) return null;
  const content = typeof value.content === "string" ? value.content : "";
  const visibility = parseVisibility(value.visibility) ?? "PUBLIC";
  const quotePolicy = parseQuotePolicy(value.quotePolicy) ?? "EVERYONE";
  const actingAccountKey =
    typeof value.actingAccountKey === "string"
      ? value.actingAccountKey
      : "personal";
  const poll = parsePoll(value.poll);
  const media = Array.isArray(value.media)
    ? value.media.map(parseMedia).filter((m): m is NoteDraftMedia => m != null)
    : [];
  const draft: StoredNoteDraft = {
    version: SCHEMA_VERSION,
    scope,
    content,
    language: optionalString(value.language),
    visibility,
    quotePolicy,
    actingAccountKey,
    quotedPostId: optionalString(value.quotedPostId),
    replyTargetId: optionalString(value.replyTargetId),
    ensureLinkUrl: optionalString(value.ensureLinkUrl),
    media,
    poll,
    // Preserve drafts saved before the datetime naming convention changed.
    updated:
      optionalString(value.updated) ??
      optionalString(value["updatedAt"]) ??
      new Date(0).toISOString(),
  };
  return isMeaningfulNoteDraft(draft) ? draft : null;
}

export function readNoteDraft(
  storage: NoteDraftStorage | undefined,
  key: string,
): StoredNoteDraft | null {
  if (storage == null) return null;
  try {
    return parseNoteDraft(storage.getItem(key));
  } catch {
    return null;
  }
}

export function writeNoteDraft(
  storage: NoteDraftStorage | undefined,
  key: string,
  scope: NoteDraftScope,
  draft: NoteDraftData,
): NoteDraftStorageResult {
  if (storage == null) return "unavailable";
  const serialized = serializeNoteDraft(scope, draft);
  try {
    if (serialized == null) {
      storage.removeItem(key);
      return "empty";
    }
    storage.setItem(key, serialized);
    return "ok";
  } catch {
    return "unavailable";
  }
}

export function removeNoteDraft(
  storage: NoteDraftStorage | undefined,
  key: string,
): NoteDraftStorageResult {
  if (storage == null) return "unavailable";
  try {
    storage.removeItem(key);
    return "ok";
  } catch {
    return "unavailable";
  }
}

function scopeToKey(scope: NoteDraftScope): string {
  switch (scope.type) {
    case "new":
      return "new";
    case "reply":
      return `reply:${encodePart(scope.targetId)}`;
    case "quote":
      return `quote:${encodePart(scope.targetId)}`;
    case "link":
      return `link:${encodePart(scope.url)}`;
    case "prefill":
      return `prefill:${encodePart(scope.content)}`;
  }
}

function encodePart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseScope(value: unknown): NoteDraftScope | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "new":
      return { type: "new" };
    case "reply":
      return typeof value.targetId === "string"
        ? { type: "reply", targetId: value.targetId }
        : null;
    case "quote":
      return typeof value.targetId === "string"
        ? { type: "quote", targetId: value.targetId }
        : null;
    case "link":
      return typeof value.url === "string"
        ? { type: "link", url: value.url }
        : null;
    case "prefill":
      return typeof value.content === "string"
        ? { type: "prefill", content: value.content }
        : null;
    default:
      return null;
  }
}

function parseVisibility(value: unknown): PostVisibility | undefined {
  return value === "PUBLIC" ||
    value === "UNLISTED" ||
    value === "FOLLOWERS" ||
    value === "DIRECT"
    ? value
    : undefined;
}

function parseQuotePolicy(value: unknown): QuotePolicy | undefined {
  return value === "EVERYONE" || value === "FOLLOWERS" || value === "SELF"
    ? value
    : undefined;
}

function parseMedia(value: unknown): NoteDraftMedia | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.localId !== "string" ||
    typeof value.mediumRelayId !== "string" ||
    typeof value.uuid !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }
  return {
    localId: value.localId,
    mediumRelayId: value.mediumRelayId,
    uuid: value.uuid,
    url: value.url,
    alt: typeof value.alt === "string" ? value.alt : "",
    width: typeof value.width === "number" ? value.width : undefined,
    height: typeof value.height === "number" ? value.height : undefined,
  };
}

function parsePoll(value: unknown): NoteDraftPoll {
  if (!isRecord(value)) return emptyPoll();
  const options = Array.isArray(value.options)
    ? value.options
        .map(parsePollOption)
        .filter((option): option is NoteDraftPollOption => option != null)
    : [];
  return {
    enabled: value.enabled === true,
    title: typeof value.title === "string" ? value.title : "",
    multiple: value.multiple === true,
    ends: typeof value.ends === "string" ? value.ends : "",
    options,
  };
}

function parsePollOption(value: unknown): NoteDraftPollOption | null {
  if (!isRecord(value)) return null;
  if (typeof value.localId !== "string" || typeof value.title !== "string") {
    return null;
  }
  return { localId: value.localId, title: value.title };
}

function emptyPoll(): NoteDraftPoll {
  return {
    enabled: false,
    title: "",
    multiple: false,
    ends: "",
    options: [],
  };
}

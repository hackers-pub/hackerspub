import { POST_VISIBILITIES } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import * as v from "@valibot/valibot";

const logger = getLogger(["hackerspub", "web", "draft-storage"]);

const DRAFT_KEY = "hackerspub:note-draft";

// Cache localStorage availability check (per page load)
let storageAvailable: boolean | null = null;

/**
 * Check if localStorage is available
 * Only performs the actual test once per page load, then caches the result
 * @returns true if localStorage is available and working
 */
function isLocalStorageAvailable(): boolean {
  // Return cached result if already checked
  if (storageAvailable != null) {
    return storageAvailable;
  }

  // First call: perform actual test (handles Safari private mode, etc.)
  try {
    const testKey = "__localStorage_test__";
    localStorage.setItem(testKey, "test");
    localStorage.removeItem(testKey);
    storageAvailable = true;
    return true;
  } catch {
    storageAvailable = false;
    return false;
  }
}

const NoteDraftSchema = v.object({
  content: v.string(),
  visibility: v.picklist(POST_VISIBILITIES),
  language: v.string(),
  media: v.array(v.object({
    url: v.string(),
    alt: v.string(),
  })),
  quotedPostId: v.nullable(
    v.pipe(v.string(), v.check((input) => validateUuid(input))),
  ),
  timestamp: v.number(),
});

export type NoteDraft = v.InferOutput<typeof NoteDraftSchema>;

/**
 * Save a note draft to localStorage
 * @returns true if save was successful, false otherwise
 */
export function saveNoteDraft(draft: NoteDraft): boolean {
  if (!isLocalStorageAvailable()) {
    return false;
  }

  try {
    const data = JSON.stringify(draft);
    localStorage.setItem(DRAFT_KEY, data);
    return true;
  } catch (error) {
    // Handle quota exceeded or other localStorage errors
    logger.error("Failed to save draft: {error}", { error });
    return false;
  }
}

/**
 * Retrieve the note draft from localStorage
 * @returns the draft object or null if not found or invalid
 */
export function getNoteDraft(): NoteDraft | null {
  if (!isLocalStorageAvailable()) {
    return null;
  }

  try {
    const data = localStorage.getItem(DRAFT_KEY);
    if (!data) return null;

    const parsed = JSON.parse(data);
    const result = v.safeParse(NoteDraftSchema, parsed);

    if (!result.success) {
      logger.warn(
        "Invalid draft structure, clearing... {issues}",
        { issues: result.issues },
      );
      clearNoteDraft();
      return null;
    }

    return result.output;
  } catch (error) {
    // Handle corrupted JSON or localStorage unavailable
    logger.error("Failed to retrieve draft: {error}", { error });
    clearNoteDraft();
    return null;
  }
}

/**
 * Clear the note draft from localStorage
 */
export function clearNoteDraft(): void {
  if (!isLocalStorageAvailable()) {
    return;
  }

  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch (error) {
    logger.error("Failed to clear draft: {error}", { error });
  }
}

/**
 * Check if a draft exists in localStorage
 * @returns true if a valid draft exists
 */
export function hasDraft(): boolean {
  return getNoteDraft() !== null;
}

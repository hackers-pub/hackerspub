import { revalidate } from "@solidjs/router";
import { createSignal } from "solid-js";

export const PROFILE_PAGE_BASE_QUERY_KEY = "loadProfilePageBaseQuery";
export const PROFILE_PAGE_POSTS_QUERY_KEY = "loadProfilePagePostsQuery";
export const PROFILE_PAGE_PINS_QUERY_KEY = "loadProfilePagePinsQuery";
export const PROFILE_NOTES_QUERY_KEY = "loadNotesPageQuery";
export const PROFILE_ARTICLES_QUERY_KEY = "loadArticlesPageQuery";
export const PROFILE_SHARES_QUERY_KEY = "loadSharesPageQuery";
export const PROFILE_INTERACTIONS_QUERY_KEY = "loadInteractionsPageQuery";

export const PROFILE_CONTENT_QUERY_KEYS = [
  PROFILE_PAGE_BASE_QUERY_KEY,
  PROFILE_PAGE_POSTS_QUERY_KEY,
  PROFILE_PAGE_PINS_QUERY_KEY,
  PROFILE_NOTES_QUERY_KEY,
  PROFILE_ARTICLES_QUERY_KEY,
  PROFILE_SHARES_QUERY_KEY,
  PROFILE_INTERACTIONS_QUERY_KEY,
];

const [profileContentRevalidating, setProfileContentRevalidating] =
  createSignal(false);

export { profileContentRevalidating };

export function holdProfileContentGate() {
  setProfileContentRevalidating(true);
}

export function releaseProfileContentGate() {
  setProfileContentRevalidating(false);
}

export async function revalidateProfileContent() {
  holdProfileContentGate();
  try {
    await revalidate(PROFILE_CONTENT_QUERY_KEYS);
  } finally {
    releaseProfileContentGate();
  }
}

import { redirect } from "@solidjs/router";
import {
  createOperationDescriptor,
  getRequest,
  type IEnvironment,
} from "relay-runtime";
import { getRequestEvent, isServer } from "solid-js/web";
import RootLayoutQueryNode from "~/routes/__generated__/RootLayoutQuery.graphql.ts";
import type { RootLayoutQuery$data } from "~/routes/__generated__/RootLayoutQuery.graphql.ts";
import { readSessionCookie } from "./sessionCookie.ts";

export type AuthGateAction = "preload" | "skip";

export function buildSignInHref(returnUrl: string): string {
  return `/sign?next=${encodeURIComponent(returnUrl)}`;
}

function snapshotViewerStatus(
  env: IEnvironment,
): "authenticated" | "anonymous" | "unknown" {
  // The (root) layout preloads RootLayoutQuery, so by the time a child
  // route's preload runs during a client-side navigation, the snapshot
  // is normally already in the store. If it isn't (cold start, race),
  // we report "unknown" and let the render-time gate handle it.
  const request = getRequest(RootLayoutQueryNode);
  const operation = createOperationDescriptor(request, {});
  const snapshot = env.lookup(operation.fragment);
  if (snapshot.isMissingData) return "unknown";
  const viewer = (snapshot.data as RootLayoutQuery$data | null)?.viewer;
  return viewer == null ? "anonymous" : "authenticated";
}

// Gate a route's preload on whether the visitor looks authenticated:
//
// - SSR without a recognizable session cookie → throws `redirect(...)`.
//   This is safe on the SSR path because preload is part of the request
//   lifecycle, and short-circuiting here avoids firing the protected
//   GraphQL query at all.
// - SSR with a session cookie → "preload". A stale/revoked cookie that
//   still passes the UUID check falls through here; the render-time
//   `useViewer()` gate catches it.
// - Client (any case) → "preload" if the layout snapshot already shows
//   an authenticated viewer; "skip" otherwise. We deliberately do not
//   throw `redirect()` on the client: route preload also runs for
//   link-hover prefetches, and a thrown Response there could trigger
//   an unintended navigation. The render-time `<Navigate>` fallback
//   handles redirecting unauthenticated visitors instead.
export function gateOnAuthentication(
  env: IEnvironment,
  returnUrl: string,
): AuthGateAction {
  if (isServer) {
    if (readSessionCookie(getRequestEvent()?.request) == null) {
      throw redirect(buildSignInHref(returnUrl));
    }
    return "preload";
  }
  return snapshotViewerStatus(env) === "authenticated" ? "preload" : "skip";
}

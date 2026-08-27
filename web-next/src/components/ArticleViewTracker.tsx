import type { Uuid } from "@hackerspub/models/uuid";
import { graphql } from "relay-runtime";
import { onCleanup, onMount } from "solid-js";
import { createMutation } from "solid-relay";
import { createArticleViewEligibilityGate } from "~/lib/articleViewEligibility.ts";
import {
  articlePageLocationChanged,
  getArticleViewReferrerHostname,
} from "~/lib/articleViewReferrer.ts";
import { getArticleViewToken } from "~/lib/articleViewToken.ts";
import type { ArticleViewTrackerMutation } from "./__generated__/ArticleViewTrackerMutation.graphql.ts";

const recordArticleViewMutation = graphql`
  mutation ArticleViewTrackerMutation(
    $articleSourceId: UUID!
    $language: Locale!
    $visitorToken: String!
    $referrerHostname: String
  ) {
    recordArticleView(
      articleSourceId: $articleSourceId
      language: $language
      visitorToken: $visitorToken
      referrerHostname: $referrerHostname
    ) {
      counted
    }
  }
`;

export interface ArticleViewTrackerProps {
  articleSourceId: Uuid | null | undefined;
  language: string | null | undefined;
  target: () => HTMLElement | undefined;
}

let clientNavigationSeen = false;

function getInitialDocumentUrl(): string | null {
  const navigation = performance.getEntriesByType("navigation")[0];
  return navigation?.name || null;
}

export function ArticleViewTracker(props: ArticleViewTrackerProps) {
  const [recordView] = createMutation<ArticleViewTrackerMutation>(
    recordArticleViewMutation,
  );

  onMount(() => {
    const articleSourceId = props.articleSourceId;
    const language = props.language;
    const target = props.target();
    if (
      articleSourceId == null ||
      language == null ||
      target == null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const mountedUrl = window.location.href;
    const initialDocumentUrl = getInitialDocumentUrl();
    if (
      initialDocumentUrl != null &&
      articlePageLocationChanged(initialDocumentUrl, mountedUrl)
    ) {
      clientNavigationSeen = true;
    }

    let intersecting = false;
    const gate = createArticleViewEligibilityGate({
      delayMilliseconds: 2_000,
      onEligible() {
        recordView({
          variables: {
            articleSourceId,
            language,
            visitorToken: getArticleViewToken(articleSourceId),
            referrerHostname: getArticleViewReferrerHostname({
              documentReferrer: document.referrer,
              currentUrl: window.location.href,
              initialDocumentUrl,
              clientNavigationSeen,
            }),
          },
          // Analytics are deliberately best effort and have no user-facing
          // failure state. Relay's network layer still reports upstream errors.
          onError() {},
        });
      },
    });
    const update = () => {
      gate.update(
        intersecting &&
          document.visibilityState === "visible" &&
          document.hasFocus(),
      );
    };
    const observer = new IntersectionObserver((entries) => {
      let matched = false;
      for (const entry of entries) {
        if (entry.target !== target) continue;
        matched = true;
        intersecting = entry.isIntersecting;
      }
      if (!matched) return;
      update();
    });
    observer.observe(target);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);

    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      gate.dispose();
      queueMicrotask(() => {
        if (articlePageLocationChanged(mountedUrl, window.location.href)) {
          clientNavigationSeen = true;
        }
      });
    });
  });

  return null;
}

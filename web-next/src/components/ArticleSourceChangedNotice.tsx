import { Show } from "solid-js";
import IconInfo from "~icons/lucide/info";
import IconTriangleAlert from "~icons/lucide/triangle-alert";
import { InternalLink } from "~/components/InternalLink.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { TranslationFreshness } from "~/lib/translationCredit.ts";
import { cn } from "~/lib/utils.ts";

export interface ArticleSourceChangedNoticeProps {
  /**
   * Freshness of the language version being read, from
   * `translationFreshness()`. `"current"` and `null` render nothing.
   */
  freshness: TranslationFreshness | null;
  /** Canonical URL of the article's original-language version. */
  originalUrl?: string | null;
  /** Same destination as a local path, for client-side navigation. */
  originalInternalHref?: string | null;
  class?: string;
}

/**
 * The notice shown above a translated body when the translation may not
 * reflect the current original.
 *
 * Two states, deliberately worded apart: `"source-changed"` is a recorded fact
 * (the original has a newer revision than the one this version was reviewed
 * against), while `"unverified"` only means no baseline was ever recorded, so
 * it must not claim that the original changed. Neither hides the translation
 * or blocks access to it.
 *
 * The markup is static and renders during SSR, so a signed-out visitor sees
 * the notice in the server response. It carries no live region: nothing about
 * it changes after the page loads.
 */
export function ArticleSourceChangedNotice(
  props: ArticleSourceChangedNoticeProps,
) {
  const { t } = useLingui();
  const stale = () =>
    props.freshness === "source-changed" || props.freshness === "unverified";
  const changed = () => props.freshness === "source-changed";

  return (
    <Show when={stale()}>
      <div
        class={cn(
          "flex max-w-[80ch] items-start gap-2 rounded-md border px-3 py-2 text-sm",
          changed()
            ? "border-warning-foreground bg-warning text-warning-foreground"
            : "border-border bg-muted text-muted-foreground",
          props.class,
        )}
      >
        <Show
          when={changed()}
          fallback={
            <IconInfo class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          }
        >
          <IconTriangleAlert
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
        </Show>
        <p>
          <strong class="font-semibold">
            {changed()
              ? t`The original has changed`
              : t`Translation freshness has not been verified.`}
          </strong>{" "}
          {changed()
            ? t`This translation may not include the latest changes to the original.`
            : t`We cannot tell whether this translation reflects the latest version of the original.`}{" "}
          <Show keyed when={props.originalUrl}>
            {(href) => (
              // A destination outside this article has no routable local path,
              // and `InternalLink` would `preventDefault()` and then hand an
              // absolute URL to the router, which refuses it: the link would
              // do nothing at all. Fall back to a plain anchor there.
              <Show
                keyed
                when={props.originalInternalHref}
                fallback={
                  <a href={href} class="font-semibold underline">
                    {t`Read the original`}
                  </a>
                }
              >
                {(internalHref) => (
                  <InternalLink
                    href={href}
                    internalHref={internalHref}
                    class="font-semibold underline"
                  >
                    {t`Read the original`}
                  </InternalLink>
                )}
              </Show>
            )}
          </Show>
        </p>
      </div>
    </Show>
  );
}

import { Show } from "solid-js";
import IconShieldAlert from "~icons/lucide/shield-alert";
import { cn } from "~/lib/utils.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface CensorshipNoticeProps {
  /**
   * Whether the current viewer (the author or a moderator) can still see the
   * post's content below this notice. For everyone else the content is
   * redacted server-side, so only this notice renders.
   */
  privileged: boolean;
  class?: string;
}

/**
 * The banner shown on a censored post in place of (or above) its content. The
 * post stays reachable by permalink so this explanation can render even though
 * the post is hidden from timelines, search, and recommendations.
 */
export function CensorshipNotice(props: CensorshipNoticeProps) {
  const { t } = useLingui();
  return (
    <div
      class={cn(
        "flex items-start gap-2 rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground",
        props.class,
      )}
    >
      <IconShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong class="font-semibold">{t`Censored by a moderator.`}</strong>
        {" "}
        {t`This post was hidden from timelines and search for violating the code of conduct.`}
        <Show when={props.privileged}>
          {" "}
          {t`Only the author and moderators can still see its content.`}
        </Show>
      </p>
    </div>
  );
}

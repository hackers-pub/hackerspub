import { A } from "@solidjs/router";
import { Show } from "solid-js";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { TranslationCredit } from "~/lib/translationCredit.ts";
import { cn } from "~/lib/utils.ts";

/**
 * Renders a translation credit as a single plain string.
 *
 * Used where a link cannot be hosted (the language menu rows, the article
 * card) and as the fallback wording for {@link ArticleTranslationCredit}, so
 * the two surfaces cannot drift apart.
 *
 * `assistance: "unknown"` is worded like `"none"` on purpose: "Translated by
 * X" attributes the work without claiming anything about how it was produced,
 * whereas the AI-assisted wording is an addition made only when that is known.
 */
export function useTranslationCreditLabel(): (
  credit: TranslationCredit,
) => string {
  const { t } = useLingui();
  return (credit) => {
    switch (credit.kind) {
      case "original":
        // Only the language menu asks for these two: the credit line under the
        // author renders nothing for them.
        return t`Original`;
      case "translating":
        return t`Translating…`;
      case "automatic":
        return t`Automatic translation`;
      case "author":
        return credit.assistance === "llm"
          ? t`AI-assisted translation, reviewed by the author`
          : t`Translated by the author`;
      case "account":
        return credit.assistance === "llm"
          ? t`AI-assisted translation, reviewed by ${`@${credit.account.username}`}`
          : t`Translated by ${`@${credit.account.username}`}`;
      case "unavailable":
        return credit.assistance === "llm"
          ? t`AI-assisted translation, reviewed by an unavailable account`
          : t`Translated by an unavailable account`;
      case "unknown":
        return t`Translation credit unavailable`;
    }
  };
}

export interface ArticleTranslationCreditProps {
  /** Classification of the language version being read. */
  credit: TranslationCredit;
  class?: string;
}

/**
 * The "translated by" line shown under an article's author line.
 *
 * It credits the language version on screen and never replaces the author or
 * the publishing organization, which keep their own line above it. A version
 * produced from an automatic draft says so, and one whose translator account
 * was deleted says that rather than silently reading as automatic.
 */
export function ArticleTranslationCredit(props: ArticleTranslationCreditProps) {
  const { t } = useLingui();
  const label = useTranslationCreditLabel();
  // Only the `account` credit links anywhere; every other wording is fixed
  // text, so it comes straight from the shared label above.
  const linked = () => {
    const credit = props.credit;
    return credit.kind === "account" ? credit : null;
  };

  return (
    <Show
      when={
        props.credit.kind !== "original" && props.credit.kind !== "translating"
      }
    >
      <p class={cn("text-sm text-muted-foreground", props.class)}>
        <Show keyed when={linked()} fallback={<>{label(props.credit)}</>}>
          {(credit) => (
            <Trans
              message={
                credit.assistance === "llm"
                  ? t`AI-assisted translation, reviewed by ${"TRANSLATOR"}`
                  : t`Translated by ${"TRANSLATOR"}`
              }
              values={{
                TRANSLATOR: () => (
                  <A
                    href={`/@${credit.account.username}`}
                    // Translators are always local accounts, so the host part
                    // of the handle is noise in a line that has to wrap on a
                    // phone; keep it as the title for the canonical form.
                    title={credit.account.handle}
                    class="text-foreground hover:underline"
                  >
                    @{credit.account.username}
                  </A>
                ),
              }}
            />
          )}
        </Show>
      </p>
    </Show>
  );
}

import type { RouteSectionProps } from "@solidjs/router";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export default function RootLayout(props: RouteSectionProps) {
  const { t } = useLingui();

  return (
    <>
      <header class="bg-stone-950 text-stone-50 dark:bg-stone-50 dark:text-stone-950 mb-4">
        <div class="container">
          <h1 class="py-4">{t`Hackers' Pub`}</h1>
        </div>
      </header>
      <main class="container">
        {props.children}
      </main>
    </>
  );
}

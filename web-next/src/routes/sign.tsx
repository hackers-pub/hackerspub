import { RouteSectionProps } from "@solidjs/router";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export default function SignLayout(props: RouteSectionProps) {
  const { t } = useLingui();

  return (
    <div class="flex flex-row items-center justify-center w-full h-screen">
      <aside class="grow h-full p-4 bg-zinc-900">
        <h1 class="text-2xl font-medium text-white">
          <a href="/">{t`Hackers' Pub`}</a>
        </h1>
      </aside>
      <main class="grow">
        {props.children}
      </main>
    </div>
  );
}

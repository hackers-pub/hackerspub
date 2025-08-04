import { RouteSectionProps } from "@solidjs/router";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export default function SignLayout(props: RouteSectionProps) {
  const { t } = useLingui();

  return (
    <div class="flex flex-row items-center justify-center w-full h-screen">
      <aside class="grow h-full p-4 bg-zinc-900">
        <h1>
          <a href="/">
            <picture>
              <source
                srcset="/logo-dark.svg"
                media="(prefers-color-scheme: dark)"
              />
              <img
                src="/logo-light.svg"
                alt={t`Hackers' Pub`}
                width={198}
                height={50}
                class="w-[198px] h-[50px]"
              />
            </picture>
          </a>
        </h1>
      </aside>
      <main class="grow">
        {props.children}
      </main>
    </div>
  );
}

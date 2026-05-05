import { Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

interface NotFoundPageProps {
  embedded?: boolean;
}

export function NotFoundPage(props: NotFoundPageProps) {
  const { i18n, t } = useLingui();
  const content = (
    <>
      <Title>Not Found{/* Do not translate */}</Title>
      <HttpStatusCode code={404} />
      <div class="w-full max-w-md flex flex-col items-center text-center gap-8">
        <A href="/" aria-label={t`Hackers' Pub home`}>
          <picture>
            <source
              srcset="/logo-dark.svg"
              media="(prefers-color-scheme: dark)"
            />
            <img
              src="/logo-light.svg"
              alt=""
              width={1391}
              height={356}
              class="h-10 w-auto"
            />
          </picture>
        </A>
        <div class="flex flex-col items-center gap-3">
          <p
            class="text-7xl md:text-8xl font-bold tracking-tight text-muted-foreground/40 leading-none select-none"
            aria-hidden="true"
          >
            404
          </p>
          <h1 class="text-2xl md:text-3xl font-semibold tracking-tight">
            {t`Page not found`}
          </h1>
          <p class="text-base text-muted-foreground max-w-sm">
            {t`The page you're looking for doesn't exist or has been moved.`}
          </p>
        </div>
        <Button as={A} href="/" size="lg">
          {t`Go home`}
        </Button>
      </div>
    </>
  );

  if (props.embedded) {
    return (
      <section class="min-h-svh flex items-center justify-center px-6 py-16 text-foreground">
        {content}
      </section>
    );
  }

  return (
    <main
      lang={new Intl.Locale(i18n.locale).minimize().baseName}
      class="min-h-svh flex items-center justify-center bg-background text-foreground px-6 py-16"
    >
      {content}
    </main>
  );
}

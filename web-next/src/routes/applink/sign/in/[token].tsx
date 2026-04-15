import { A, useParams, useSearchParams } from "@solidjs/router";
import { onMount } from "solid-js";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export default function AppLinkVerify() {
  const { t } = useLingui();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const token = () => params.token ?? "";
  const code = () => {
    const c = searchParams.code;
    return Array.isArray(c) ? c[0] ?? "" : c ?? "";
  };

  const appLink = () =>
    `hackerspub://verify?token=${encodeURIComponent(token())}&code=${
      encodeURIComponent(code())
    }`;

  const webFallback = () =>
    `/sign/in/${encodeURIComponent(token())}?code=${
      encodeURIComponent(code())
    }&platform=web`;

  onMount(() => {
    try {
      window.location.href = appLink();
    } catch {
      // Custom scheme not handled — fallback buttons are shown
    }
  });

  return (
    <div class="flex min-h-screen items-center justify-center bg-background">
      <div class="flex flex-col items-center gap-4 p-6 text-center">
        <p class="text-lg font-medium">
          {t`Sign in to Hackers' Pub`}
        </p>
        <Button
          as="a"
          href={appLink()}
          size="lg"
          class="w-full rounded-full"
        >
          {t`Open in app`}
        </Button>
        <Button
          as={A}
          href={webFallback()}
          variant="secondary"
          size="lg"
          class="w-full rounded-full"
        >
          {t`Continue in browser`}
        </Button>
      </div>
    </div>
  );
}

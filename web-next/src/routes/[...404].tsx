import { Title } from "@solidjs/meta";
import { HttpStatusCode } from "@solidjs/start";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export default function NotFound() {
  const { t } = useLingui();
  return (
    <main>
      <Title>Not Found{/* Do not translate */}</Title>
      <HttpStatusCode code={404} />
      <h1>{t`Page Not Found`}</h1>
    </main>
  );
}

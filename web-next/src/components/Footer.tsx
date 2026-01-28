import { useLingui } from "~/lib/i18n/macro.d.ts";
import { Trans } from "./Trans.tsx";

export interface FooterProps {
  class?: string;
}

export function Footer(props: FooterProps) {
  const { t } = useLingui();

  return (
    <footer
      class={`p-4 text-xs text-muted-foreground ${props.class ?? ""}`}
    >
      <p class="underline mb-2">
        <a href="/coc">{t`Code of conduct`}</a>
      </p>
      <p>
        <Trans
          message={t`The source code of this website is available on ${"GITHUB_REPOSITORY"} under the ${"AGPL-3.0"} license.`}
          values={{
            GITHUB_REPOSITORY: () => (
              <a
                href="https://github.com/hackers-pub/hackerspub"
                target="_blank"
                class="underline"
              >
                {t`GitHub repository`}
              </a>
            ),
            "AGPL-3.0": () => (
              <a
                href="https://www.gnu.org/licenses/agpl-3.0.en.html"
                target="_blank"
                class="underline"
              >
                AGPL 3.0
              </a>
            ),
          }}
        />
      </p>
    </footer>
  );
}

import type { Toc } from "@hackerspub/models/markup";
import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { TocList } from "~/components/TocList.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { DocumentView_document$key } from "./__generated__/DocumentView_document.graphql.ts";

export interface DocumentViewProps {
  $document: DocumentView_document$key;
}

export function DocumentView(props: DocumentViewProps) {
  const { t } = useLingui();
  const document = createFragment(
    graphql`
      fragment DocumentView_document on Document {
        title
        html
        toc
      }
    `,
    () => props.$document,
  );

  return (
    <Show keyed when={document()}>
      {(document) => (
        <div class="flex flex-row-reverse items-start">
          <Title>{document.title}</Title>
          <aside class="sticky top-0 hidden h-dvh w-64 shrink-0 overflow-auto border-l bg-background/80 p-5 backdrop-blur lg:block">
            <h1 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t`Table of contents`}
            </h1>
            <TocList
              items={document.toc as Toc[]}
              class="text-sm leading-6 text-muted-foreground"
            />
          </aside>
          <div
            class="prose prose-slate mx-auto w-full max-w-3xl px-4 py-6 dark:prose-invert sm:px-6 lg:px-8"
            innerHTML={document.html}
          />
        </div>
      )}
    </Show>
  );
}

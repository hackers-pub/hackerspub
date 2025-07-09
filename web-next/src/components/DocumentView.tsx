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
    <Show when={document()}>
      {(document) => (
        <div class="flex flex-row-reverse">
          <Title>{document().title}</Title>
          <aside class="border-l p-4 hidden lg:block h-dvh sticky top-0">
            <h1 class="text-xs font-medium opacity-75">
              {t`Table of contents`}
            </h1>
            <TocList
              items={document().toc as Toc[]}
              class="text-sm"
            />
          </aside>
          <div
            class="p-4 prose dark:prose-invert ml-auto mr-auto"
            innerHTML={document().html}
          />
        </div>
      )}
    </Show>
  );
}

import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { useSidebar } from "~/components/ui/sidebar.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { FloatingComposeButton_signedAccount$key } from "./__generated__/FloatingComposeButton_signedAccount.graphql.ts";

export interface FloatingComposeButtonProps {
  show: boolean;
  username?: string;
  $signedAccount?: FloatingComposeButton_signedAccount$key | null;
}

export function FloatingComposeButton(props: FloatingComposeButtonProps) {
  const { t } = useLingui();
  const { isMobile, state } = useSidebar();
  const { open: openNoteCompose } = useNoteCompose();

  const signedAccount = createFragment(
    graphql`
      fragment FloatingComposeButton_signedAccount on Account
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 3 }
        ) {
        articleDrafts(after: $cursor, first: $count)
          @connection(key: "FloatingComposeButton_articleDrafts") {
          __id
          edges {
            node {
              id
            }
          }
        }
      }
    `,
    () => props.$signedAccount,
  );

  const shouldShow = () =>
    props.show && (isMobile() || state() === "collapsed");

  return (
    <>
      <Show when={shouldShow()}>
        <div class="fixed bottom-6 right-6 z-50">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger>
              <Button
                size="lg"
                class="size-14 rounded-full shadow-lg"
                aria-label={t`Compose`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onSelect={openNoteCompose}
                class="cursor-pointer"
              >
                <div class="flex items-center gap-2 whitespace-nowrap">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-4 shrink-0"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
                    />
                  </svg>
                  <span>{t`Create Note`}</span>
                </div>
              </DropdownMenuItem>
              <Show when={props.username}>
                <DropdownMenuItem class="cursor-pointer">
                  <A
                    href={`/@${props.username}/drafts/new`}
                    class="flex items-center gap-2 whitespace-nowrap"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="1.5"
                      stroke="currentColor"
                      class="size-4 shrink-0"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>

                    <span>{t`Create Article`}</span>
                  </A>
                </DropdownMenuItem>
                <Show
                  when={(signedAccount()?.articleDrafts.edges.length ?? 0) > 0}
                >
                  <DropdownMenuItem class="cursor-pointer">
                    <A
                      href={`/@${props.username}/drafts`}
                      class="flex items-center gap-2 whitespace-nowrap"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        class="size-4 shrink-0"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                        />
                      </svg>
                      <span>{t`Go to Drafts`}</span>
                    </A>
                  </DropdownMenuItem>
                </Show>
              </Show>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Show>
    </>
  );
}

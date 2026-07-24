import { Index, Show } from "solid-js";
import IconSquare from "~icons/lucide/square";
import IconX from "~icons/lucide/x";
import type { MediaController } from "./createMediaController.ts";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";

export interface MediaEditorProps {
  media: MediaController;
}

export function MediaEditor(props: MediaEditorProps) {
  const { t } = useLingui();

  return (
    <div class="flex flex-col gap-3">
      <Index each={props.media.items()}>
        {(item, index) => (
          <div class="flex gap-3 items-start">
            <div class="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted">
              <img
                src={item().previewUrl}
                alt=""
                class="w-full h-full object-cover"
              />
              <Show when={item().uploading}>
                <div class="absolute inset-0 flex flex-col items-center justify-center bg-background/70 gap-1 px-2">
                  <progress
                    value={item().uploadProgress}
                    max={100}
                    class="w-full h-1.5 rounded-full"
                    aria-label={t`Upload progress`}
                  />
                  <span class="text-xs text-muted-foreground">
                    {item().uploadProgress}%
                  </span>
                </div>
              </Show>
            </div>

            <div class="flex-1 flex flex-col gap-1.5">
              <textarea
                value={item().alt}
                aria-label={t`Alt text for image ${index + 1}`}
                aria-required="true"
                required
                onInput={(event) =>
                  props.media.setAlt(item().localId, event.currentTarget.value)
                }
                placeholder={t`Alt text for visually impaired people (required)`}
                disabled={item().generatingAlt}
                rows={3}
                class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <div class="flex gap-1 justify-end">
                <Show when={item().mediumRelayId && !item().uploading}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={item().generatingAlt}
                    aria-label={t`Auto-fill alt text`}
                    title={t`Auto-fill alt text`}
                    onClick={() => props.media.generateAlt(item().localId)}
                  >
                    <Show
                      when={item().generatingAlt}
                      fallback={<span class="text-xs">{t`Auto-fill`}</span>}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        class="size-4 animate-spin"
                        aria-hidden="true"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                        />
                      </svg>
                      <span class="text-xs ml-1">{t`Generating…`}</span>
                    </Show>
                  </Button>
                </Show>
                <Show when={item().generatingAlt}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t`Cancel`}
                    title={t`Cancel`}
                    onClick={() => props.media.cancelAlt(item().localId)}
                  >
                    <IconSquare class="size-4" />
                  </Button>
                </Show>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground hover:text-foreground"
                  aria-label={t`Remove image`}
                  title={t`Remove image`}
                  onClick={() => props.media.remove(item().localId)}
                >
                  <IconX class="size-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Index>
    </div>
  );
}

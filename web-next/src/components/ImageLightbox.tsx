import * as DialogPrimitive from "@kobalte/core/dialog";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";

interface LightboxMedium {
  url: string;
  alt?: string | null;
}

interface ImageLightboxProps {
  media: readonly LightboxMedium[];
  initialIndex: number;
  open: boolean;
  onClose: () => void;
}

export function ImageLightbox(props: ImageLightboxProps) {
  const { t } = useLingui();
  const [currentIndex, setCurrentIndex] = createSignal(0);

  createEffect(() => {
    if (props.open) {
      setCurrentIndex(props.initialIndex);
    }
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        setCurrentIndex((i) => Math.min(props.media.length - 1, i + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const currentMedium = () => props.media[currentIndex()];
  const hasPrev = () => currentIndex() > 0;
  const hasNext = () => currentIndex() < props.media.length - 1;

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black/90 data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
        <DialogPrimitive.Content
          class="fixed inset-0 z-50 flex items-center justify-center outline-none data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0"
          onClick={(e: MouseEvent) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <DialogPrimitive.Title class="sr-only">
            {t`Image preview`}
          </DialogPrimitive.Title>
          <DialogPrimitive.CloseButton class="absolute top-4 right-4 bg-black/50 hover:bg-black/80 text-white/90 hover:text-white transition-colors p-1.5 rounded-full focus:outline-none focus:ring-2 focus:ring-white/50">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-6"
            >
              <path d="M18 6l-12 12" />
              <path d="M6 6l12 12" />
            </svg>
            <span class="sr-only">{t`Close`}</span>
          </DialogPrimitive.CloseButton>
          <Show when={hasPrev()}>
            <button
              type="button"
              class="absolute left-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white/90 hover:text-white transition-colors p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-white/50"
              aria-label={t`Previous image`}
              onClick={() => setCurrentIndex((i) => i - 1)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-6"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </Show>
          <div class="flex max-h-[95vh] max-w-[calc(95vw-6rem)] flex-col items-center">
            <Show when={currentMedium()}>
              {(medium) => (
                <>
                  <img
                    src={medium().url}
                    alt={medium().alt ?? undefined}
                    class="min-h-0 max-w-full max-h-[calc(95vh-4rem)] object-contain"
                  />
                  <Show when={medium().alt?.trim()}>
                    {(alt) => (
                      <p class="mt-2 max-h-[4rem] max-w-full overflow-y-auto whitespace-pre-wrap break-words text-center text-sm text-white/80">
                        {alt()}
                      </p>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show when={props.media.length > 1}>
              <p class="mt-1 text-xs text-white/50">
                {currentIndex() + 1} / {props.media.length}
              </p>
            </Show>
          </div>
          <Show when={hasNext()}>
            <button
              type="button"
              class="absolute right-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/80 text-white/90 hover:text-white transition-colors p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-white/50"
              aria-label={t`Next image`}
              onClick={() => setCurrentIndex((i) => i + 1)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-6"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </Show>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

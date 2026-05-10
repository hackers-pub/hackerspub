import * as DialogPrimitive from "@kobalte/core/dialog";
import { createEffect, createSignal, Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";

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

  const currentMedium = () => props.media[currentIndex()];

  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black/90 data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
        <div class="fixed inset-0 z-50 flex items-center justify-center">
          <DialogPrimitive.Content class="relative flex flex-col items-center outline-none data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95">
            <DialogPrimitive.Title class="sr-only">
              {t`Image preview`}
            </DialogPrimitive.Title>
            <DialogPrimitive.CloseButton class="absolute -top-10 right-0 text-white/70 hover:text-white transition-colors p-1 rounded-sm focus:outline-none focus:ring-2 focus:ring-white/50">
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
            <Show when={currentMedium()}>
              {(medium) => (
                <img
                  src={medium().url}
                  alt={medium().alt ?? undefined}
                  class="max-w-[95vw] max-h-[85vh] object-contain"
                />
              )}
            </Show>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

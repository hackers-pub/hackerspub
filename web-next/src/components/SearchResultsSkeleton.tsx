import { For } from "solid-js";
import { Skeleton } from "~/components/ui/skeleton.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export function SearchResultsSkeleton() {
  const { t } = useLingui();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      class="mb-10 mt-4 overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12"
    >
      <span class="sr-only">{t`Loading search results…`}</span>
      <Skeleton class="h-7 w-1/2 m-4" />
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex gap-4 border-t p-4">
            <Skeleton class="size-10 shrink-0 rounded-full" />
            <div class="flex-1 space-y-2 py-1">
              <Skeleton class="h-4 w-1/3" />
              <Skeleton class="h-3 w-full" />
              <Skeleton class="h-3 w-5/6" />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

import { For } from "solid-js";
import { Skeleton } from "~/components/ui/skeleton.tsx";

export function PostListSkeleton() {
  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <For each={Array.from({ length: 3 })}>
        {() => (
          <div class="flex gap-3 border-b p-4 last:border-b-0">
            <Skeleton animate class="size-10 shrink-0 rounded-full" />
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton animate class="h-3 w-32 rounded" />
              <Skeleton animate class="h-3 w-full rounded" />
              <Skeleton animate class="h-3 w-4/5 rounded" />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

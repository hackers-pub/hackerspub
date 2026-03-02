import { type Accessor, createEffect, onCleanup } from "solid-js";
import { useBeforeLeave } from "@solidjs/router";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export function useUnsavedGuard(isDirty: Accessor<boolean>): void {
  const { t } = useLingui();

  // Router navigation guard
  useBeforeLeave((e) => {
    if (isDirty() && !e.defaultPrevented) {
      e.preventDefault();
      setTimeout(() => {
        if (window.confirm(t`Discard unsaved changes - are you sure?`)) {
          e.retry(true);
        }
      }, 100);
    }
  });

  // Browser refresh/close guard
  createEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    onCleanup(() => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    });
  });
}

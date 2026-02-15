import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { debounce } from "es-toolkit";

export interface UseAutoSaveOptions {
  title: Accessor<string>;
  content: Accessor<string>;
  tags: Accessor<string[]>;
  draft: Accessor<
    { title: string; content: string; tags: readonly string[] } | undefined
  >;
  save: () => void;
  isSaving: Accessor<boolean>;
  isPublishing: Accessor<boolean>;
}

export interface UseAutoSaveReturn {
  isDirty: Accessor<boolean>;
  setIsDirty: (v: boolean) => void;
}

export function useAutoSave(options: UseAutoSaveOptions): UseAutoSaveReturn {
  const [isDirty, setIsDirty] = createSignal(false);

  // Track dirty state
  createEffect(() => {
    const currentDraft = options.draft();
    const hasChanges = options.title() !== (currentDraft?.title ?? "") ||
      options.content() !== (currentDraft?.content ?? "") ||
      JSON.stringify(options.tags()) !==
        JSON.stringify(currentDraft?.tags ?? []);
    setIsDirty(hasChanges);
  });

  // Debounced auto-save (1.5 second interval)
  const debouncedAutoSave = debounce(() => {
    if (!options.isSaving() && options.title().trim() && isDirty()) {
      options.save();
    }
  }, 1500);

  // Auto-save effect
  createEffect(() => {
    if (isDirty() && !options.isPublishing()) {
      debouncedAutoSave();
    }
  });

  // Cancel pending debounce only on unmount
  onCleanup(() => {
    debouncedAutoSave.cancel();
  });

  return { isDirty, setIsDirty };
}

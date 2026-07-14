import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import {
  decideExternalDraftChange,
  shouldPreserveCurrentDraftForm,
} from "./draftState.ts";
import { getBrowserLocalStorage } from "~/lib/browserStorage.ts";
import {
  getNoteDraftStorageKey,
  isMeaningfulNoteDraft,
  type NoteDraftData,
  type NoteDraftScope,
  readNoteDraft,
  removeNoteDraft,
  type StoredNoteDraft,
  writeNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import {
  publishNoteDraftChange,
  registerNoteDraftFlush,
  subscribeNoteDraftChanges,
} from "~/lib/noteDraftSync.ts";

export type DraftSaveStatus = "idle" | "saved" | "unavailable";
export type DraftFlush = () => boolean;

export interface DraftControllerOptions {
  readonly active: Accessor<boolean>;
  readonly editing: Accessor<boolean>;
  readonly username: Accessor<string | null | undefined>;
  readonly scope: Accessor<NoteDraftScope | null>;
  readonly dirty: Accessor<boolean>;
  readonly snapshot: () => NoteDraftData;
  readonly hasUnstorableMedia: Accessor<boolean>;
  readonly apply: (draft: StoredNoteDraft) => void;
  readonly resetForm: () => void;
  readonly resetFormForScope: (scope: NoteDraftScope) => void;
  readonly onFlushAvailable: Accessor<
    ((flush: DraftFlush | null) => void) | undefined
  >;
}

export interface DraftController {
  readonly storageKey: Accessor<string | null>;
  readonly hasLocalDraft: Accessor<boolean>;
  readonly saveStatus: Accessor<DraftSaveStatus>;
  readonly meaningful: Accessor<boolean>;
  readonly showDeleteConfirm: Accessor<boolean>;
  readonly setShowDeleteConfirm: (show: boolean) => void;
  readonly saveNow: DraftFlush;
  readonly clear: () => void;
  readonly deleteAndReset: () => void;
}

export function createDraftController(
  options: DraftControllerOptions,
): DraftController {
  const storageKey = createMemo(() => {
    if (!options.active()) return null;
    const scope = options.scope();
    const username = options.username();
    if (scope == null || username == null) return null;
    return getNoteDraftStorageKey(username, scope);
  });
  const [loadedKey, setLoadedKey] = createSignal<string | null>(null);
  const [hasLocalDraft, setHasLocalDraft] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<DraftSaveStatus>("idle");
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let formKey: string | null = null;
  let restoring = false;
  let unregisterFlush: (() => void) | undefined;
  const origin = Symbol("NoteComposer");

  const meaningful = createMemo(() =>
    !options.editing() && isMeaningfulNoteDraft(options.snapshot())
  );

  const saveNow = (notifyChange = true): boolean => {
    const key = storageKey();
    const scope = options.scope();
    if (
      key == null || scope == null || loadedKey() !== key || restoring
    ) {
      return !options.dirty();
    }

    clearTimeout(saveTimer);
    const draft = options.snapshot();
    const unstorableMedia = options.hasUnstorableMedia();
    const result = writeNoteDraft(getBrowserLocalStorage(), key, scope, draft);
    setHasLocalDraft(result === "ok");
    if (result === "ok") {
      formKey = key;
      setSaveStatus(unstorableMedia ? "idle" : "saved");
      if (notifyChange) publishNoteDraftChange({ key, origin });
      return !unstorableMedia;
    }
    if (result === "empty" && notifyChange) {
      publishNoteDraftChange({ key, origin });
    }
    if (result === "unavailable" && isMeaningfulNoteDraft(draft)) {
      setSaveStatus("unavailable");
      return false;
    }
    setSaveStatus("idle");
    return !options.dirty();
  };

  const apply = (draft: StoredNoteDraft) => {
    restoring = true;
    options.apply(draft);
    queueMicrotask(() => {
      restoring = false;
    });
  };

  const load = (
    key: string,
    scope: NoteDraftScope,
    preserveCurrentForm: boolean,
  ) => {
    setSaveStatus("idle");
    const draft = readNoteDraft(getBrowserLocalStorage(), key);
    if (draft != null) {
      if (!preserveCurrentForm) apply(draft);
      setHasLocalDraft(true);
    } else {
      if (!preserveCurrentForm) options.resetFormForScope(scope);
      setHasLocalDraft(false);
    }
    formKey = key;
    setLoadedKey(key);
  };

  const clear = () => {
    const key = storageKey();
    if (key == null) return;
    removeNoteDraft(getBrowserLocalStorage(), key);
    setHasLocalDraft(false);
    setSaveStatus("idle");
    publishNoteDraftChange({ key, origin });
  };

  createEffect(() => {
    options.onFlushAvailable()?.(options.editing() ? null : saveNow);
  });

  createEffect(() => {
    unregisterFlush?.();
    unregisterFlush = undefined;
    const scope = options.scope();
    if (options.editing() || !options.active() || scope == null) return;
    unregisterFlush = registerNoteDraftFlush(scope, saveNow);
  });

  createEffect(() => {
    const key = storageKey();
    const scope = options.scope();
    clearTimeout(saveTimer);
    if (key == null || scope == null) {
      setSaveStatus("idle");
      setLoadedKey(null);
      formKey = null;
      setHasLocalDraft(false);
      return;
    }
    const previousLoadedKey = untrack(loadedKey);
    const preserveCurrentForm = untrack(() =>
      shouldPreserveCurrentDraftForm({
        previousLoadedKey,
        formDraftKey: formKey,
        nextKey: key,
        dirty: options.dirty(),
      })
    );
    untrack(() => load(key, scope, preserveCurrentForm));
  });

  onCleanup(subscribeNoteDraftChanges((change) => {
    const decision = decideExternalDraftChange({
      sameOrigin: change.origin === origin,
      changeKey: change.key,
      currentKey: untrack(storageKey),
      dirty: untrack(options.dirty),
    });
    if (decision === "ignore") return;
    const key = untrack(storageKey);
    const scope = untrack(options.scope);
    if (key == null || scope == null) return;
    clearTimeout(saveTimer);
    load(key, scope, decision === "preserve-and-resave");
    if (decision === "preserve-and-resave") {
      saveTimer = setTimeout(() => saveNow(false), 350);
    }
  }));

  createEffect(() => {
    const key = storageKey();
    const scope = options.scope();
    // Track the form even while applying a restored draft.  Otherwise this
    // effect can return on its first run without subscribing to the snapshot,
    // and later edits to an existing local draft are never persisted.
    void options.snapshot();
    if (key == null || scope == null || loadedKey() !== key || restoring) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  });

  onCleanup(() => {
    saveNow();
    options.onFlushAvailable()?.(null);
    unregisterFlush?.();
    clearTimeout(saveTimer);
  });

  return {
    storageKey,
    hasLocalDraft,
    saveStatus,
    meaningful,
    showDeleteConfirm,
    setShowDeleteConfirm,
    saveNow,
    clear,
    deleteAndReset: () => {
      setShowDeleteConfirm(false);
      clear();
      options.resetForm();
    },
  };
}

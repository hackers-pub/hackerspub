import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import IconPencil from "~icons/lucide/pencil";
import { NoteComposer } from "~/components/NoteComposer.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { getBrowserLocalStorage } from "~/lib/browserStorage.ts";
import {
  getNoteDraftStorageKey,
  readNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import { subscribeNoteDraftChanges } from "~/lib/noteDraftSync.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export function TimelineNoteComposer() {
  const { t } = useLingui();
  const viewer = useViewer();
  const { notifyNoteCreated } = useNoteCompose();
  const location = useLocation();
  const [expanded, setExpanded] = createSignal(false);
  const [hasSavedDraft, setHasSavedDraft] = createSignal(false);
  const [savedDraftPreview, setSavedDraftPreview] = createSignal<string | null>(
    null,
  );
  let composerContainerRef: HTMLDivElement | undefined;

  const draftStorageKey = createMemo(() => {
    const username = viewer.username();
    return username == null
      ? null
      : getNoteDraftStorageKey(username, { type: "new" });
  });

  const getBrowserDraftStorage = getBrowserLocalStorage;

  const updateSavedDraftStatus = () => {
    const key = draftStorageKey();
    const draft = key == null
      ? null
      : readNoteDraft(getBrowserDraftStorage(), key);
    setHasSavedDraft(draft != null);
    setSavedDraftPreview(draft?.content.trim() || null);
  };

  createEffect(updateSavedDraftStatus);

  onCleanup(subscribeNoteDraftChanges((change) => {
    if (change.key === draftStorageKey()) updateSavedDraftStatus();
  }));

  const handleSuccess = () => {
    notifyNoteCreated();
    setExpanded(false);
    updateSavedDraftStatus();
  };

  const placeholder = () =>
    hasSavedDraft()
      ? (savedDraftPreview() ?? t`Local draft`)
      : t`What's on your mind?`;

  const expandComposer = () => {
    setExpanded(true);
    requestAnimationFrame(() => {
      composerContainerRef?.querySelector("textarea")?.focus();
    });
  };

  createEffect(() => {
    if (location.query.compose !== "note") return;
    expandComposer();
    const nextSearch = new URLSearchParams(location.search);
    nextSearch.delete("compose");
    const suffix = nextSearch.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${suffix ? `?${suffix}` : ""}${location.hash}`,
    );
  });

  return (
    <div class="mt-4 overflow-hidden border bg-card md:rounded-lg md:shadow-sm">
      <Show
        when={expanded()}
        fallback={
          <div class="px-3 py-3 sm:px-4">
            <button
              type="button"
              class="flex min-h-28 w-full cursor-text items-start justify-between gap-3 rounded-md border border-input bg-background px-3 py-3 text-left text-base text-foreground/70 ring-offset-background transition-colors hover:border-ring/60 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={expandComposer}
            >
              <span class="line-clamp-3 min-w-0 whitespace-pre-wrap break-words pt-0.5">
                {placeholder()}
              </span>
              <IconPencil class="mt-1 size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        }
      >
        <div ref={composerContainerRef} class="px-3 py-4 sm:px-4">
          <NoteComposer onSuccess={handleSuccess} autoFocus />
        </div>
      </Show>
    </div>
  );
}

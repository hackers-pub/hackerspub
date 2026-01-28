import { debounce } from "es-toolkit";
import { fetchQuery, graphql } from "relay-runtime";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useRelayEnvironment } from "solid-relay";
import type {
  MentionAutocompleteQuery,
  MentionAutocompleteQuery$data,
} from "./__generated__/MentionAutocompleteQuery.graphql.ts";

const MENTION_PREFIX_REGEXP = /@(?:[^\s@]+(?:@[^\s@]*)?)?$/;

const mentionAutocompleteQuery = graphql`
  query MentionAutocompleteQuery($prefix: String!, $limit: Int) {
    searchActorsByHandle(prefix: $prefix, limit: $limit) {
      id
      handle
      username
      rawName
      avatarUrl
    }
  }
`;

type Actor = NonNullable<
  MentionAutocompleteQuery$data["searchActorsByHandle"]
>[number];

interface CandidatesState {
  x: number;
  y: number;
  actors?: readonly Actor[];
  selectedIndex: number;
  version: number;
}

export interface MentionAutocompleteProps {
  textareaRef: () => HTMLTextAreaElement | undefined;
  onComplete: (handle: string) => void;
}

export function MentionAutocomplete(props: MentionAutocompleteProps) {
  const environment = useRelayEnvironment();
  const [candidates, setCandidates] = createSignal<CandidatesState | undefined>(
    undefined,
  );
  const [requestVersion, setRequestVersion] = createSignal(0);
  const [isMouseOverDropdown, setIsMouseOverDropdown] = createSignal(false);
  const [mountPoint, setMountPoint] = createSignal<HTMLElement | undefined>(
    undefined,
  );
  let candidatesRef: HTMLDivElement | undefined;

  onMount(() => {
    let el = document.getElementById("mention-autocomplete-portal");
    if (!el) {
      el = document.createElement("div");
      el.id = "mention-autocomplete-portal";
      document.body.appendChild(el);
    }
    setMountPoint(el);
  });

  // Scroll selected item into view
  createEffect(() => {
    const c = candidates();
    if (c == null || c.actors == null || candidatesRef == null) return;
    const selected = candidatesRef.querySelector(
      `[data-index="${c.selectedIndex}"]`,
    ) as HTMLDivElement | null;
    if (selected == null) return;
    const containerRect = candidatesRef.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (selectedRect.top < containerRect.top) {
      candidatesRef.scrollBy({
        top: selectedRect.top - containerRect.top,
        behavior: "smooth",
      });
    } else if (selectedRect.bottom > containerRect.bottom) {
      candidatesRef.scrollBy({
        top: selectedRect.bottom - containerRect.bottom,
        behavior: "smooth",
      });
    }
  });

  function getCursorPosition(
    textArea: HTMLTextAreaElement,
    cursor?: number,
  ): { x: number; y: number } {
    const mirror = document.createElement("div");
    mirror.style.position = "fixed";
    mirror.style.left = "0";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.width = `${textArea.clientWidth}px`;
    const computedStyle = getComputedStyle(textArea);
    mirror.style.font = computedStyle.font;
    mirror.style.lineHeight = computedStyle.lineHeight;
    mirror.style.padding = computedStyle.padding;
    const text = textArea.value.substring(
      0,
      cursor ?? textArea.selectionStart,
    );
    mirror.appendChild(document.createTextNode(text));
    const span = document.createElement("span");
    span.textContent = ".";
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const rect = span.getBoundingClientRect();
    document.body.removeChild(mirror);
    const textAreaRect = textArea.getBoundingClientRect();
    return {
      x: textAreaRect.left + rect.x - textArea.scrollLeft,
      y: textAreaRect.top + rect.y + rect.height - textArea.scrollTop,
    };
  }

  const debouncedFetch = debounce((prefix: string, version: number) => {
    fetchQuery<MentionAutocompleteQuery>(
      environment(),
      mentionAutocompleteQuery,
      {
        prefix,
        limit: 25,
      },
    ).subscribe({
      next(data) {
        // Only update if this is the latest request
        if (requestVersion() !== version) return;
        setCandidates((c) =>
          c == null ? undefined : {
            ...c,
            actors: data.searchActorsByHandle ?? [],
            selectedIndex:
              c.selectedIndex >= (data.searchActorsByHandle?.length ?? 0)
                ? 0
                : c.selectedIndex,
          }
        );
      },
      error(err: Error) {
        console.error("Mention autocomplete error:", err);
      },
    });
  }, 150);

  function handleInput() {
    const textArea = props.textareaRef();
    if (textArea == null) return;

    const text = textArea.value.substring(0, textArea.selectionStart);
    const match = MENTION_PREFIX_REGEXP.exec(text);

    if (match == null) {
      setCandidates(undefined);
      return;
    }

    const version = requestVersion() + 1;
    setRequestVersion(version);

    // Update position immediately
    setCandidates((c) => ({
      ...c,
      ...getCursorPosition(textArea, match.index),
      selectedIndex: c?.selectedIndex ?? 0,
      version,
    }));

    // Debounce the fetch
    debouncedFetch(match[0], version);
  }

  function handleKeyDown(event: KeyboardEvent) {
    const c = candidates();
    if (c == null || c.actors == null || c.actors.length === 0) return;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        setCandidates((c) =>
          c == null ? undefined : {
            ...c,
            selectedIndex: (c.selectedIndex - 1 + (c.actors?.length ?? 0)) %
              (c.actors?.length ?? 1),
          }
        );
        break;

      case "ArrowDown":
        event.preventDefault();
        setCandidates((c) =>
          c == null ? undefined : {
            ...c,
            selectedIndex: (c.selectedIndex + 1) % (c.actors?.length ?? 1),
          }
        );
        break;

      case "Enter": {
        const actor = c.actors[c.selectedIndex];
        if (actor) {
          event.preventDefault();
          complete(actor);
        }
        break;
      }

      case "Escape":
        event.preventDefault();
        setCandidates(undefined);
        break;
    }
  }

  function complete(actor: Actor) {
    const textArea = props.textareaRef();
    if (textArea == null) return;

    const text = textArea.value.substring(0, textArea.selectionStart);
    const match = MENTION_PREFIX_REGEXP.exec(text);
    if (match == null) return;

    const start = match.index;
    const end = start + match[0].length;
    const inserted = actor.handle +
      (textArea.value.charAt(end).match(/^\s$/) ? "" : " ");
    const newText = textArea.value.substring(0, start) +
      inserted +
      textArea.value.substring(end);
    const newPosition = start + inserted.length;

    // Update textarea value and selection
    textArea.value = newText;
    textArea.selectionStart = newPosition;
    textArea.selectionEnd = newPosition;
    textArea.focus();

    // Trigger input event to notify the form
    const inputEvent = new Event("input", { bubbles: true });
    textArea.dispatchEvent(inputEvent);

    // Notify parent component
    props.onComplete(actor.handle);

    setCandidates(undefined);
  }

  function handleBlur(event: FocusEvent) {
    // Check if focus is moving to the dropdown
    const relatedTarget = event.relatedTarget as Node | null;
    if (
      candidatesRef && relatedTarget && candidatesRef.contains(relatedTarget)
    ) {
      return;
    }
    // Delay to allow click on candidates
    setTimeout(() => {
      if (!isMouseOverDropdown()) {
        setCandidates(undefined);
      }
    }, 200);
  }

  // Attach event listeners to textarea
  createEffect(
    on(
      () => props.textareaRef(),
      (textArea) => {
        if (textArea == null) return;

        textArea.addEventListener("input", handleInput);
        textArea.addEventListener("keydown", handleKeyDown);
        textArea.addEventListener("blur", handleBlur);

        onCleanup(() => {
          textArea.removeEventListener("input", handleInput);
          textArea.removeEventListener("keydown", handleKeyDown);
          textArea.removeEventListener("blur", handleBlur);
        });
      },
    ),
  );

  return (
    <Show
      when={mountPoint() && candidates() &&
        (candidates()?.actors == null ||
          (candidates()?.actors?.length ?? 0) > 0)}
    >
      <Portal mount={mountPoint()}>
        <div
          ref={(el) => (candidatesRef = el)}
          role="listbox"
          tabindex="-1"
          class="fixed z-[9999] mt-1 bg-popover border border-border text-popover-foreground shadow-md rounded-md max-h-40 overflow-y-auto pointer-events-auto"
          style={{
            left: `${candidates()?.x ?? 0}px`,
            top: `${candidates()?.y ?? 0}px`,
          }}
          aria-hidden="false"
          onMouseEnter={() => setIsMouseOverDropdown(true)}
          onMouseLeave={() => setIsMouseOverDropdown(false)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Show when={candidates()?.actors == null}>
            <div class="px-3 py-2 text-muted-foreground">...</div>
          </Show>
          <For each={candidates()?.actors}>
            {(actor, index) => (
              <div
                data-index={index()}
                role="option"
                aria-selected={index() === candidates()?.selectedIndex}
                tabindex="-1"
                class={`flex items-center gap-2 px-3 py-2 cursor-pointer ${
                  index() === candidates()?.selectedIndex ? "bg-accent" : ""
                }`}
                style={{ cursor: "pointer" }}
                onMouseOver={() => {
                  setCandidates((c) =>
                    c == null ? undefined : { ...c, selectedIndex: index() }
                  );
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  complete(actor);
                }}
              >
                <Show when={actor.avatarUrl}>
                  <img
                    src={actor.avatarUrl}
                    width={20}
                    height={20}
                    class="rounded-full"
                    alt=""
                  />
                </Show>
                <span class="font-medium">{actor.handle}</span>
                <Show when={actor.rawName}>
                  <span class="text-muted-foreground text-sm">
                    {actor.rawName}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  );
}

import { debounce } from "es-toolkit";
import { fetchQuery, graphql } from "relay-runtime";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { cn } from "~/lib/utils.ts";
import type {
  ActorHandleAutocompleteQuery,
  ActorHandleAutocompleteQuery$data,
} from "./__generated__/ActorHandleAutocompleteQuery.graphql.ts";

const actorHandleAutocompleteQuery = graphql`
  query ActorHandleAutocompleteQuery($prefix: String!) {
    searchActorsByHandle(prefix: $prefix, limit: 8) {
      uuid
      handle
      rawName
      avatarUrl
      avatarInitials
    }
  }
`;

type ActorSuggestion = NonNullable<
  ActorHandleAutocompleteQuery$data["searchActorsByHandle"]
>[number];

/** The branded UUID type Relay generates for the `UUID` scalar. */
export type Uuid = ActorSuggestion["uuid"];

export interface ActorHandleAutocompleteProps {
  /** Visible label for the input. */
  readonly label: string;
  /** `id` shared by the label and input for accessibility. */
  readonly inputId: string;
  /** The controlled handle text. */
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly class?: string;
  /** Called as the moderator types (a manual edit, not a suggestion pick). */
  onInput(value: string): void;
  /** Called when a suggestion is chosen; carries the resolved actor. */
  onSelect(actor: { uuid: Uuid; handle: string }): void;
}

/**
 * A handle text field with avatar-rich autocomplete backed by
 * `searchActorsByHandle`.  Picking a suggestion hands the caller the resolved
 * actor (so it can skip a second lookup); typing reports the raw text.
 */
export function ActorHandleAutocomplete(props: ActorHandleAutocompleteProps) {
  const environment = useRelayEnvironment();
  const [suggestions, setSuggestions] = createSignal<
    readonly ActorSuggestion[]
  >([]);
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  // Stable ids wiring the input to its listbox and active option for the
  // ARIA combobox pattern (the input keeps focus; options are not tabbable).
  const listboxId = () => `${props.inputId}-listbox`;
  const optionId = (index: number) => `${props.inputId}-option-${index}`;
  // Monotonic request id so a slow in-flight search cannot overwrite the
  // results of a later keystroke.
  let requestId = 0;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;

  const runSearch = debounce((prefix: string, id: number) => {
    fetchQuery<ActorHandleAutocompleteQuery>(
      environment(),
      actorHandleAutocompleteQuery,
      { prefix },
    ).subscribe({
      next(data) {
        if (id !== requestId) return;
        const actors = data.searchActorsByHandle ?? [];
        setSuggestions(actors);
        setActiveIndex(0);
        setOpen(actors.length > 0);
      },
      error() {
        if (id !== requestId) return;
        setSuggestions([]);
        setOpen(false);
      },
    });
  }, 150);

  function onInput(value: string) {
    props.onInput(value);
    const prefix = value.trim().replace(/^@/, "");
    requestId += 1;
    if (prefix.length < 1) {
      setSuggestions([]);
      setOpen(false);
      runSearch.cancel();
      return;
    }
    runSearch(prefix, requestId);
  }

  function pick(actor: ActorSuggestion) {
    requestId += 1; // invalidate any in-flight search
    runSearch.cancel();
    setOpen(false);
    setSuggestions([]);
    props.onSelect({ uuid: actor.uuid, handle: actor.handle });
  }

  function onKeyDown(event: KeyboardEvent) {
    const list = suggestions();
    if (!open() || list.length < 1) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % list.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + list.length) % list.length);
        break;
      case "Enter": {
        const actor = list[activeIndex()];
        if (actor) {
          event.preventDefault();
          pick(actor);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
    }
  }

  onCleanup(() => {
    runSearch.cancel();
    if (blurTimer != null) clearTimeout(blurTimer);
  });

  return (
    <TextField class={cn("grid gap-1.5", props.class)}>
      <TextFieldLabel for={props.inputId}>{props.label}</TextFieldLabel>
      <div class="relative">
        <TextFieldInput
          id={props.inputId}
          type="text"
          autocomplete="off"
          role="combobox"
          aria-expanded={open()}
          aria-autocomplete="list"
          aria-controls={open() ? listboxId() : undefined}
          aria-activedescendant={open() && suggestions().length > 0
            ? optionId(activeIndex())
            : undefined}
          placeholder={props.placeholder}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => onInput(e.currentTarget.value)}
          onFocus={() => setOpen(suggestions().length > 0)}
          onBlur={() => {
            // Delay so a click on a suggestion (which blurs the input) still
            // registers before the list unmounts.
            blurTimer = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={open() && suggestions().length > 0}>
          <ul
            role="listbox"
            id={listboxId()}
            class="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
            // Keep focus on the input (so blur/submit behave) while clicking.
            onPointerDown={(e) => e.preventDefault()}
          >
            <For each={suggestions()}>
              {(actor, index) => (
                // The option row itself is the selectable element (no nested
                // interactive control, which would be invalid inside `option`).
                // Keyboard nav lives on the input via `aria-activedescendant`.
                <li
                  role="option"
                  id={optionId(index())}
                  aria-selected={index() === activeIndex()}
                  class={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-3 py-2",
                    index() === activeIndex() && "bg-accent",
                  )}
                  onMouseEnter={() => setActiveIndex(index())}
                  onClick={() => pick(actor)}
                >
                  <Avatar class="size-7">
                    <AvatarImage src={actor.avatarUrl ?? undefined} />
                    <AvatarFallback class="text-xs">
                      {actor.avatarInitials}
                    </AvatarFallback>
                  </Avatar>
                  <span class="min-w-0 flex-1">
                    <Show when={actor.rawName}>
                      <span class="block truncate text-sm font-medium">
                        {actor.rawName}
                      </span>
                    </Show>
                    <span class="block truncate font-mono text-xs text-muted-foreground">
                      {actor.handle}
                    </span>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </TextField>
  );
}

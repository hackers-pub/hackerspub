import { debounce } from "es-toolkit";
import { fetchQuery, graphql } from "relay-runtime";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { cn } from "~/lib/utils.ts";
import type {
  ActorHandleAutocompleteQuery,
  ActorHandleAutocompleteQuery$data,
} from "./__generated__/ActorHandleAutocompleteQuery.graphql.ts";

const actorHandleAutocompleteQuery = graphql`
  query ActorHandleAutocompleteQuery($prefix: String!, $limit: Int = 8) {
    searchActorsByHandle(prefix: $prefix, limit: $limit) {
      uuid
      handle
      username
      rawName
      avatarUrl
      avatarInitials
      account {
        id
        username
        name
        avatarUrl
        kind
      }
    }
  }
`;

type ActorSuggestion = NonNullable<
  ActorHandleAutocompleteQuery$data["searchActorsByHandle"]
>[number];

export type ActorHandleAutocompleteActor = ActorSuggestion;

/** The branded UUID type Relay generates for the `UUID` scalar. */
export type Uuid = ActorSuggestion["uuid"];

export interface ActorHandleAutocompleteSelectedActor {
  readonly username: string;
  readonly name?: string | null;
  readonly avatarUrl?: string | null;
}

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
  /** Keep suggestions to actors backed by a local account. */
  readonly localAccountsOnly?: boolean;
  /** Keep suggestions to a specific local account kind. */
  readonly accountKind?: "PERSONAL" | "ORGANIZATION";
  /** Prefer a local username over a fediverse handle in the suggestion row. */
  readonly suggestionIdentifier?: "handle" | "username";
  /** Optional content inside the input, before the typed value. */
  readonly leading?: JSX.Element;
  /** Optional selected account summary rendered under the input. */
  readonly selectedActor?: ActorHandleAutocompleteSelectedActor | null;
  /** Optional helper text rendered under the input. */
  readonly description?: JSX.Element;
  /** Called as the moderator types (a manual edit, not a suggestion pick). */
  onInput(value: string): void;
  /** Called when a suggestion is chosen; carries the resolved actor. */
  onSelect(actor: ActorHandleAutocompleteActor): void;
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
    const limit = props.localAccountsOnly || props.accountKind != null ? 25 : 8;
    fetchQuery<ActorHandleAutocompleteQuery>(
      environment(),
      actorHandleAutocompleteQuery,
      { prefix, limit },
    ).subscribe({
      next(data) {
        if (id !== requestId) return;
        const actors = (data.searchActorsByHandle ?? []).filter((actor) => {
          if (!props.localAccountsOnly && props.accountKind == null) {
            return true;
          }
          if (actor.account == null) return false;
          return (
            props.accountKind == null ||
            actor.account.kind === props.accountKind
          );
        });
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
    props.onSelect(actor);
  }

  function actorIdentifier(actor: ActorSuggestion) {
    if (props.suggestionIdentifier === "username" && actor.account != null) {
      return actor.account.username;
    }
    return actor.handle;
  }

  function selectedActorName(actor: ActorHandleAutocompleteSelectedActor) {
    return actor.name?.trim() || actor.username;
  }

  function selectedActorInitials(actor: ActorHandleAutocompleteSelectedActor) {
    const name = selectedActorName(actor);
    const parts = name.split(/[\s_-]+/).filter((part) => part.length > 0);
    if (parts.length === 0) {
      return Array.from(actor.username)[0]?.toUpperCase() ?? "?";
    }
    if (parts.length === 1) {
      return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
    }
    const firstInitial = Array.from(parts[0])[0];
    const lastInitial = Array.from(parts[parts.length - 1])[0];
    return `${firstInitial ?? ""}${lastInitial ?? ""}`.toUpperCase() || "?";
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
        <Show when={props.leading}>
          <span class="pointer-events-none absolute left-3 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center">
            {props.leading}
          </span>
        </Show>
        <TextFieldInput
          id={props.inputId}
          type="text"
          class={cn(props.leading != null && "pl-11")}
          autocomplete="off"
          role="combobox"
          aria-expanded={open()}
          aria-autocomplete="list"
          aria-controls={open() ? listboxId() : undefined}
          aria-activedescendant={
            open() && suggestions().length > 0
              ? optionId(activeIndex())
              : undefined
          }
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
                      {actorIdentifier(actor)}
                    </span>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <Show keyed when={props.selectedActor}>
        {(actor) => (
          <div class="flex min-w-0 items-center gap-2 rounded-md bg-muted/45 px-3 py-2">
            <Avatar class="size-7">
              <AvatarImage src={actor.avatarUrl ?? undefined} />
              <AvatarFallback class="text-xs">
                {selectedActorInitials(actor)}
              </AvatarFallback>
            </Avatar>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">
                {selectedActorName(actor)}
              </span>
              <span class="block truncate font-mono text-xs text-muted-foreground">
                @{actor.username}
              </span>
            </span>
          </div>
        )}
      </Show>
      <Show when={props.description}>
        <TextFieldDescription>{props.description}</TextFieldDescription>
      </Show>
    </TextField>
  );
}

import { escape } from "@std/html/entities";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { renderCustomEmojis } from "../models/emoji.ts";
import type { Actor } from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";

export type MarkupTextAreaProps = JSX.TextareaHTMLAttributes<
  HTMLTextAreaElement
>;

interface Candidates {
  x: number;
  y: number;
  actors?: Actor[];
  selectedActorId?: Uuid;
  version?: number;
}

const MENTION_PREFIX_REGEXP = /@(?:[^\s@]+(?:@[^\s@]*)?)?$/;

export function MarkupTextArea(props: MarkupTextAreaProps) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(
    props.ref != null && "current" in props.ref ? props.ref.current : null,
  );
  const candidatesRef = useRef<HTMLDivElement | null>(null);
  const [candidates, setCandidates] = useState<Candidates | undefined>();

  useEffect(() => {
    if (candidates == null || candidates.selectedActorId == null) return;
    // Scroll the candidates div to the selected actor
    const selected = candidatesRef.current?.querySelector(
      `[data-actor-id="${candidates.selectedActorId}"]`,
    ) as HTMLDivElement | null;
    if (selected == null) return;
    const candidatesDiv = candidatesRef.current;
    const candidatesRect = candidatesDiv?.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (candidatesRect == null) return;
    if (selectedRect.top < candidatesRect.top) {
      candidatesDiv?.scrollBy({
        top: selectedRect.top - candidatesRect.top,
        behavior: "smooth",
      });
    } else if (selectedRect.bottom > candidatesRect.bottom) {
      candidatesDiv?.scrollBy({
        top: selectedRect.bottom - candidatesRect.bottom,
        behavior: "smooth",
      });
    }
  }, [candidates]);

  function onInput(
    this: undefined,
    event: JSX.TargetedInputEvent<HTMLTextAreaElement>,
  ) {
    const target = event.currentTarget;
    if (target != null) {
      const text = target.value.substring(0, target.selectionStart);
      const match = MENTION_PREFIX_REGEXP.exec(text);
      if (match == null) {
        setCandidates(undefined);
      } else {
        setCandidates((candidates) => ({
          ...candidates,
          ...getCursorPosition(target, match.index),
        }));
        fetch("/api/mention?prefix=" + encodeURIComponent(match[0]), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Echo-Nonce": new Date().getTime().toString(),
          },
          credentials: "include",
        })
          .then(async (response) =>
            [
              await response.json() as Actor[],
              response.headers.get("Echo-Nonce"),
            ] satisfies [Actor[], string | null]
          )
          .then(([actors, nonce]) => {
            if (nonce == null) return;
            const version = parseInt(nonce);
            setCandidates((candidates) =>
              candidates == null || candidates.version != null &&
                  candidates.version > version
                ? candidates
                : {
                  ...candidates,
                  actors,
                  selectedActorId: candidates.selectedActorId == null
                    ? undefined
                    : actors.some((a) => a.id === candidates.selectedActorId)
                    ? candidates.selectedActorId
                    : undefined,
                  version,
                }
            );
          });
      }
    }
    if (props.onInput != null) props.onInput.call(this, event);
  }

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
    const text = textArea.value.substring(0, cursor ?? textArea.selectionStart);
    mirror.appendChild(document.createTextNode(text));
    const span = document.createElement("span");
    span.textContent = ".";
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const rect = span.getBoundingClientRect();
    document.body.removeChild(mirror);
    const textAreaRect = textArea.getBoundingClientRect();
    return {
      x: globalThis.scrollX + textAreaRect.x + rect.x - textArea.scrollLeft,
      y: globalThis.scrollY + textAreaRect.y + rect.y + rect.height -
        textArea.scrollTop,
    };
  }

  function onKeyDown(
    this: undefined,
    event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      candidates != null && candidates.actors != null &&
      candidates.actors.length > 0
    ) {
      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown":
          event.preventDefault();
          setCandidates((candidates) => {
            if (
              candidates == null || candidates.actors == null ||
              candidates.actors.length < 1
            ) {
              return candidates;
            }
            const index = candidates.actors.findIndex(
              (actor) => actor.id === candidates.selectedActorId,
            );
            return {
              ...candidates,
              selectedActorId: candidates.actors[
                (index + (event.key === "ArrowUp" ? -1 : 1) +
                  candidates.actors.length) %
                candidates.actors.length
              ].id,
            };
          });
          return;

        case "Enter": {
          const textArea = event.currentTarget;
          if (complete(textArea)) {
            event.preventDefault();
            return;
          }
          break;
        }

        case "Escape":
          event.preventDefault();
          setCandidates(undefined);
          break;
      }
    }
    if (props.onKeyDown != null) props.onKeyDown.call(this, event);
  }

  function complete(textArea: HTMLTextAreaElement): boolean {
    if (candidates?.actors == null || candidates.selectedActorId == null) {
      return false;
    }
    const text = textArea.value.substring(0, textArea.selectionStart);
    const match = MENTION_PREFIX_REGEXP.exec(text);
    if (match == null) return false;
    const actor = candidates.actors.find(
      (actor) => actor.id === candidates.selectedActorId,
    );
    if (actor == null) return false;
    const start = match.index;
    const end = start + match[0].length;
    const inserted = actor.handle +
      (textArea.value.charAt(end).match(/^\s$/) ? "" : " ");
    const newText = textArea.value.substring(0, start) +
      inserted +
      textArea.value.substring(end);
    const newPosition = start + inserted.length;
    // Update the value and selection
    textArea.value = newText;
    textArea.selectionStart = newPosition;
    textArea.selectionEnd = newPosition;
    // Trigger input event to notify React
    const inputEvent = new Event("input", { bubbles: true });
    textArea.dispatchEvent(inputEvent);
    setCandidates(undefined);
    return true;
  }

  function onSelect(
    this: undefined,
    event: JSX.TargetedEvent<HTMLTextAreaElement>,
  ) {
    if (candidates != null) {
      setCandidates(undefined);
    }
    if (props.onSelect != null) props.onSelect.call(this, event);
  }

  function onBlur(
    this: undefined,
    event: JSX.TargetedFocusEvent<HTMLTextAreaElement>,
  ) {
    setTimeout(() => {
      setCandidates(undefined);
    }, 150);
    if (props.onBlur != null) props.onBlur.call(this, event);
  }

  return (
    <>
      <textarea
        {...props}
        ref={textAreaRef}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        onBlur={onBlur}
      />
      {candidates &&
        (candidates.actors == null || candidates.actors.length > 0) && (
        <div
          ref={candidatesRef}
          class={`
            absolute z-50 mt-1
            bg-stone-200 dark:bg-stone-700 border
            border-stone-400 dark:border-stone-500
            text-stone-800 dark:text-stone-100
            ${candidates.actors == null ? "opacity-50" : ""}
            max-h-[10rem] overflow-y-scroll
          `}
          style={{
            left: `${candidates.x}px`,
            top: `${candidates.y}px`,
          }}
        >
          {candidates.actors == null
            ? <>&hellip;</>
            : candidates.actors.map((actor) => (
              <div
                key={actor.id}
                data-actor-id={actor.id}
                class={`p-3 cursor-pointer ${
                  actor.id === candidates.selectedActorId
                    ? "bg-stone-300 dark:bg-stone-600"
                    : ""
                }`}
                onMouseOver={() => {
                  setCandidates((candidates) =>
                    candidates == null ? undefined : {
                      ...candidates,
                      selectedActorId: actor.id,
                    }
                  );
                }}
                onClick={() => {
                  setCandidates((candidates) =>
                    candidates == null ? undefined : {
                      ...candidates,
                      selectedActorId: actor.id,
                    }
                  );
                  if (textAreaRef.current == null) return;
                  complete(textAreaRef.current);
                }}
              >
                {actor.avatarUrl && (
                  <img
                    src={actor.avatarUrl}
                    width={16}
                    height={16}
                    class="inline-block mr-1"
                  />
                )}
                {actor.handle} {actor.name != null && (
                  <span
                    class="opacity-50"
                    dangerouslySetInnerHTML={{
                      __html: renderCustomEmojis(
                        escape(actor.name),
                        actor.emojis,
                      ),
                    }}
                  />
                )}
              </div>
            ))}
        </div>
      )}
    </>
  );
}

import type { NoteDraftScope } from "~/lib/noteDraftStorage.ts";

export type NoteDraftFlush = () => boolean;

export interface NoteDraftChange {
  readonly key: string;
  readonly origin: symbol;
}

type NoteDraftChangeCallback = (change: NoteDraftChange) => void;

const flushers = new Map<NoteDraftFlush, NoteDraftScope>();
const listeners = new Set<NoteDraftChangeCallback>();

export function registerNoteDraftFlush(
  scope: NoteDraftScope,
  flush: NoteDraftFlush,
): () => void {
  flushers.set(flush, scope);
  return () => {
    flushers.delete(flush);
  };
}

export function flushNoteDraftScope(scope: NoteDraftScope): boolean {
  let flushed = true;
  for (const [flush, registeredScope] of flushers) {
    if (sameNoteDraftScope(scope, registeredScope)) {
      flushed = flush() && flushed;
    }
  }
  return flushed;
}

export function publishNoteDraftChange(change: NoteDraftChange): void {
  for (const listener of listeners) {
    listener(change);
  }
}

export function subscribeNoteDraftChanges(
  listener: NoteDraftChangeCallback,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameNoteDraftScope(a: NoteDraftScope, b: NoteDraftScope): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "new":
      return true;
    case "reply":
    case "quote":
      return a.targetId === (b as typeof a).targetId;
    case "link":
      return a.url === (b as typeof a).url;
    case "prefill":
      return a.content === (b as typeof a).content;
  }
}

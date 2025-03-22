import type { Actor } from "./schema.ts";

export function getAvatarUrl(actor: Actor): string {
  return actor.avatarUrl ?? "https://gravatar.com/avatar/?d=mp&s=128";
}

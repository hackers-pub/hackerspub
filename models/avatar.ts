export function getAvatarUrl(actor: { avatarUrl: string | null }): string {
  return actor.avatarUrl ?? "https://gravatar.com/avatar/?d=mp&s=128";
}

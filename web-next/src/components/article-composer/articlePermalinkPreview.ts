import type { ComposeActingAccountOption } from "~/components/ActingAccountSelect.tsx";

export interface ArticlePermalinkPreviewOptions {
  origin: string;
  routeHandle: string;
  year: number;
  actingAccountKey: string;
  actingAccountOptions: readonly ComposeActingAccountOption[];
}

export function getArticlePermalinkPreviewPrefix(
  options: ArticlePermalinkPreviewOptions,
): string {
  const actingAccount = options.actingAccountOptions.find(
    (option) => option.value === options.actingAccountKey,
  )?.accounts[0];
  const handle = actingAccount?.username
    ? `@${actingAccount.username}`
    : options.routeHandle;

  return `${options.origin}/${handle}/${options.year}/`;
}

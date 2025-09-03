import { Show } from "solid-js";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface LanguageListProps {
  readonly locales: readonly [Intl.Locale, ...readonly Intl.Locale[]];
  onChange?(locales: readonly [Intl.Locale, ...readonly Intl.Locale[]]): void;
}

export function LanguageList(props: LanguageListProps) {
  const { t, i18n } = useLingui();
  const displayNames = new Intl.DisplayNames(i18n.locale, { type: "language" });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead class="shrink">{t`Language code`}</TableHead>
          <TableHead>{t`Language`}</TableHead>
          <TableHead>{t`Native name`}</TableHead>
          <TableHead class="shrink"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.locales.map((locale, idx) => (
          <TableRow>
            <TableCell class="font-mono">{locale.baseName}</TableCell>
            <TableCell>{displayNames.of(locale.baseName)}</TableCell>
            <TableCell lang={locale.baseName}>
              {new Intl.DisplayNames(locale.baseName, { type: "language" }).of(
                locale.baseName,
              )}
            </TableCell>
            <TableCell class="text-right">
              <Show when={props.locales.length > 1}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={Button<"button">}
                    variant="ghost"
                    class="cursor-pointer"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="1.5"
                      stroke="currentColor"
                      class="size-6"
                      aria-label={t`Actions`}
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"
                      />
                    </svg>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuLabel>{t`Priority`}</DropdownMenuLabel>
                    <Show when={idx > 0}>
                      <DropdownMenuItem
                        class="gap-1 cursor-pointer"
                        on:click={() =>
                          props.onChange?.(
                            [
                              props.locales[idx],
                              ...props.locales.filter((_, i) => i !== idx),
                            ],
                          )}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1.5"
                          stroke="currentColor"
                          class="size-4"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m4.5 18.75 7.5-7.5 7.5 7.5"
                          />
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m4.5 12.75 7.5-7.5 7.5 7.5"
                          />
                        </svg>
                        <span>{t`Move to the top`}</span>
                      </DropdownMenuItem>
                    </Show>
                    <Show when={idx > 1}>
                      <DropdownMenuItem
                        class="gap-1 cursor-pointer"
                        on:click={() =>
                          props.onChange?.(
                            [
                              ...props.locales.slice(0, idx - 1),
                              props.locales[idx],
                              props.locales[idx - 1],
                              ...props.locales.slice(idx + 1),
                            ] as [Intl.Locale, ...readonly Intl.Locale[]],
                          )}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1.5"
                          stroke="currentColor"
                          class="size-4"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m4.5 15.75 7.5-7.5 7.5 7.5"
                          />
                        </svg>
                        <span>{t`Move up`}</span>
                      </DropdownMenuItem>
                    </Show>
                    <Show when={idx < props.locales.length - 2}>
                      <DropdownMenuItem
                        class="gap-1 cursor-pointer"
                        on:click={() =>
                          props.onChange?.(
                            [
                              ...props.locales.slice(0, idx),
                              props.locales[idx + 1],
                              props.locales[idx],
                              ...props.locales.slice(idx + 2),
                            ] as [Intl.Locale, ...readonly Intl.Locale[]],
                          )}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1.5"
                          stroke="currentColor"
                          class="size-4"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m19.5 8.25-7.5 7.5-7.5-7.5"
                          />
                        </svg>
                        <span>{t`Move down`}</span>
                      </DropdownMenuItem>
                    </Show>
                    <Show when={idx < props.locales.length - 1}>
                      <DropdownMenuItem
                        class="gap-1 cursor-pointer"
                        on:click={() =>
                          props.onChange?.(
                            [
                              ...props.locales.filter((_, i) => i !== idx),
                              props.locales[idx],
                            ] as unknown as [
                              Intl.Locale,
                              ...readonly Intl.Locale[],
                            ],
                          )}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1.5"
                          stroke="currentColor"
                          class="size-4"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m4.5 5.25 7.5 7.5 7.5-7.5m-15 6 7.5 7.5 7.5-7.5"
                          />
                        </svg>
                        <span>{t`Move to the bottom`}</span>
                      </DropdownMenuItem>
                    </Show>
                    <DropdownMenuLabel>{t`Actions`}</DropdownMenuLabel>
                    <DropdownMenuItem
                      class="gap-1 cursor-pointer"
                      on:click={() =>
                        props.onChange?.(
                          props.locales.filter((_, i) =>
                            i !== idx
                          ) as unknown as [
                            Intl.Locale,
                            ...readonly Intl.Locale[],
                          ],
                        )}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        class="size-4"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                        />
                      </svg>
                      <span>{t`Remove`}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Show>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

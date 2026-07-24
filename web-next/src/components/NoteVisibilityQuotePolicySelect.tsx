import { For } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { PostVisibility } from "./PostVisibilitySelect.tsx";
import type { QuotePolicy } from "./QuotePolicySelect.tsx";
import IconAtSign from "~icons/lucide/at-sign";
import IconCheck from "~icons/lucide/check";
import IconChevronsUpDown from "~icons/lucide/chevrons-up-down";
import IconGlobe2 from "~icons/lucide/globe-2";
import IconLockKeyhole from "~icons/lucide/lock-keyhole";
import IconMoon from "~icons/lucide/moon";
import IconRepeat2 from "~icons/lucide/repeat-2";
import IconUsers from "~icons/lucide/users";

export interface NoteVisibilityQuotePolicySelectProps {
  visibility: PostVisibility;
  quotePolicy: QuotePolicy;
  onVisibilityChange?: (value: PostVisibility) => void;
  onQuotePolicyChange?: (value: QuotePolicy) => void;
  visibilityDisabled?: boolean;
}

export function NoteVisibilityQuotePolicySelect(
  props: NoteVisibilityQuotePolicySelectProps,
) {
  const { t } = useLingui();
  const check = () => <IconCheck class="size-4" />;
  const visibilityOptions = () => [
    {
      value: "PUBLIC" as const,
      label: t`Public`,
      icon: () => <IconGlobe2 class="size-4" />,
    },
    {
      value: "UNLISTED" as const,
      label: t`Quiet public`,
      icon: () => <IconMoon class="size-4" />,
    },
    {
      value: "FOLLOWERS" as const,
      label: t`Followers only`,
      icon: () => <IconLockKeyhole class="size-4" />,
    },
    {
      value: "DIRECT" as const,
      label: t`Mentioned only`,
      icon: () => <IconAtSign class="size-4" />,
    },
  ];
  const quoteOptions = () => [
    {
      value: "EVERYONE" as const,
      label: t`Anyone can quote`,
      icon: () => <IconRepeat2 class="size-4" />,
    },
    {
      value: "FOLLOWERS" as const,
      label: t`Followers can quote`,
      icon: () => <IconUsers class="size-4" />,
    },
    {
      value: "SELF" as const,
      label: t`Only you can quote`,
      icon: () => <IconLockKeyhole class="size-4" />,
    },
  ];
  const quotePolicyLocked = () =>
    props.visibility !== "PUBLIC" && props.visibility !== "UNLISTED";
  const effectiveQuotePolicy = () =>
    quotePolicyLocked() ? "SELF" : props.quotePolicy;
  const selectedVisibility = () =>
    visibilityOptions().find((option) => option.value === props.visibility) ??
    visibilityOptions()[0];
  const selectedQuotePolicy = () =>
    quoteOptions().find((option) => option.value === effectiveQuotePolicy()) ??
    quoteOptions()[0];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        class="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-[18rem]"
        aria-label={t`Visibility and quote permission`}
      >
        <span class="flex min-w-0 flex-1 items-center gap-2">
          {selectedVisibility().icon()}
          <span class="truncate">{selectedVisibility().label}</span>
          <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
          {selectedQuotePolicy().icon()}
          <span class="truncate">{selectedQuotePolicy().label}</span>
        </span>
        <IconChevronsUpDown class="size-4 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-[18rem]">
        <DropdownMenuRadioGroup<PostVisibility>
          value={props.visibility}
          onChange={(value) => props.onVisibilityChange?.(value)}
        >
          <DropdownMenuGroup>
            <DropdownMenuGroupLabel class="px-2 py-1 text-xs font-semibold text-muted-foreground">
              {t`Visibility`}
            </DropdownMenuGroupLabel>
            <For each={visibilityOptions()}>
              {(option) => (
                <DropdownMenuRadioItem
                  value={option.value}
                  disabled={props.visibilityDisabled}
                  indicator={check()}
                  indicatorPlacement="right"
                  class="gap-2"
                >
                  {option.icon()}
                  <span class="truncate">{option.label}</span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup<QuotePolicy>
          value={effectiveQuotePolicy()}
          onChange={(value) => props.onQuotePolicyChange?.(value)}
        >
          <DropdownMenuGroup>
            <DropdownMenuGroupLabel class="px-2 py-1 text-xs font-semibold text-muted-foreground">
              {t`Quote permission`}
            </DropdownMenuGroupLabel>
            <For each={quoteOptions()}>
              {(option) => (
                <DropdownMenuRadioItem
                  value={option.value}
                  disabled={quotePolicyLocked() && option.value !== "SELF"}
                  indicator={check()}
                  indicatorPlacement="right"
                  class="gap-2"
                >
                  {option.icon()}
                  <span class="truncate">{option.label}</span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

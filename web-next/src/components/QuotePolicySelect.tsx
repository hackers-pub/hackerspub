import type { JSX } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import { cn } from "~/lib/utils.ts";
import IconLockKeyhole from "~icons/lucide/lock-keyhole";
import IconRepeat2 from "~icons/lucide/repeat-2";
import IconUsers from "~icons/lucide/users";

export type QuotePolicy = "EVERYONE" | "FOLLOWERS" | "SELF";

export interface QuotePolicySelectProps {
  value: QuotePolicy;
  onChange?: (value: QuotePolicy) => void;
  disabled?: boolean;
  class?: string;
}

export function QuotePolicySelect(props: QuotePolicySelectProps) {
  const { t } = useLingui();
  const options = () => [
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
  return (
    <Select
      value={options().find((o) => o.value === props.value) ?? options()[0]}
      onChange={(o) => props.onChange?.(o?.value ?? "EVERYONE")}
      options={options()}
      optionValue="value"
      optionTextValue="label"
      disabled={props.disabled}
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          <div class="flex flex-row gap-1 items-center">
            {props.item.rawValue.icon()}
            <span>{props.item.rawValue.label}</span>
          </div>
        </SelectItem>
      )}
    >
      <SelectTrigger class={cn("w-[220px]", props.class)}>
        <SelectValue<{
          value: QuotePolicy;
          label: string;
          icon: () => JSX.Element;
        }>>
          {(state) => (
            <div class="flex flex-row gap-1 items-center">
              {state.selectedOption().icon()}
              <span>{state.selectedOption().label}</span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

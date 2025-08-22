import { JSX } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export type PostVisibility = "PUBLIC" | "UNLISTED" | "FOLLOWERS" | "DIRECT";

export interface PostVisibilitySelectProps {
  value: PostVisibility;
  onChange?: (value: PostVisibility) => void;
}

export function PostVisibilitySelect(props: PostVisibilitySelectProps) {
  const { t } = useLingui();
  const options = () => [
    {
      value: "PUBLIC" as const,
      label: t`Public`,
      icon: (
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
            d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418"
          />
        </svg>
      ),
    },
    {
      value: "UNLISTED" as const,
      label: t`Quiet public`,
      icon: (
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
            d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
          />
        </svg>
      ),
    },
    {
      value: "FOLLOWERS" as const,
      label: t`Followers only`,
      icon: (
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
            d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
      ),
    },
    {
      value: "DIRECT" as const,
      label: t`Mentioned only`,
      icon: (
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
            d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25"
          />
        </svg>
      ),
    },
  ];
  return (
    <Select
      value={options().find((o) => o.value === props.value) ?? options()[0]}
      onChange={(o) => props.onChange?.(o?.value ?? "PUBLIC")}
      options={options()}
      optionValue="value"
      optionTextValue="label"
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          <div class="flex flex-row gap-1 items-center">
            {props.item.rawValue.icon}
            <span>{props.item.rawValue.label}</span>
          </div>
        </SelectItem>
      )}
    >
      <SelectTrigger class="w-[180px]">
        <SelectValue<
          { value: PostVisibility; label: string; icon: JSX.Element }
        >>
          {(state) => (
            <div class="flex flex-row gap-1 items-center">
              {state.selectedOption().icon}
              <span>{state.selectedOption().label}</span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

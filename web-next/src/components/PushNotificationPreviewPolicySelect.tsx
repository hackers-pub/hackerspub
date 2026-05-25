import type { JSX } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconEye from "~icons/lucide/eye";
import IconEyeOff from "~icons/lucide/eye-off";
import IconShieldCheck from "~icons/lucide/shield-check";

export type PushNotificationPreviewPolicy = "PUBLIC_ONLY" | "ALL" | "NONE";

export interface PushNotificationPreviewPolicySelectProps {
  value: PushNotificationPreviewPolicy;
  onChange?: (value: PushNotificationPreviewPolicy) => void;
  disabled?: boolean;
}

export function PushNotificationPreviewPolicySelect(
  props: PushNotificationPreviewPolicySelectProps,
) {
  const { t } = useLingui();
  const options = () => [
    {
      value: "PUBLIC_ONLY" as const,
      label: t`Public posts only`,
      icon: () => <IconShieldCheck class="size-4" />,
    },
    {
      value: "ALL" as const,
      label: t`All notifications`,
      icon: () => <IconEye class="size-4" />,
    },
    {
      value: "NONE" as const,
      label: t`No previews`,
      icon: () => <IconEyeOff class="size-4" />,
    },
  ];
  return (
    <Select
      value={options().find((o) => o.value === props.value) ?? options()[0]}
      onChange={(o) => props.onChange?.(o?.value ?? "PUBLIC_ONLY")}
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
      <SelectTrigger class="w-full sm:w-[220px]">
        <SelectValue<
          {
            value: PushNotificationPreviewPolicy;
            label: string;
            icon: () => JSX.Element;
          }
        >>
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

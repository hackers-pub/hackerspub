import type { Accessor, JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import IconBuilding2 from "~icons/lucide/building-2";
import IconUsers from "~icons/lucide/users";
import IconUserRound from "~icons/lucide/user-round";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import {
  organizationComposeAccountKey,
  PERSONAL_COMPOSE_ACCOUNT_KEY,
  type PostAttributionMode,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { cn } from "~/lib/utils.ts";

export interface ComposeActingAccountOption {
  value: string;
  accountId?: string;
  attributionMode?: PostAttributionMode;
  label: string;
  detail: string;
  avatarUrl?: string | null;
  coauthored: boolean;
  icon: () => JSX.Element;
}

export interface ActingAccountSelectProps {
  value: string;
  onChange: (value: string) => void;
  class?: string;
  disabled?: boolean;
}

export function useComposeActingAccountOptions(): Accessor<
  ComposeActingAccountOption[]
> {
  const { t } = useLingui();
  const actingAccount = useActingAccount();

  return createMemo(() => {
    const personalAccount = actingAccount.personalAccount();
    if (personalAccount == null) return [];

    const options: ComposeActingAccountOption[] = [
      {
        value: PERSONAL_COMPOSE_ACCOUNT_KEY,
        label: t`Personal account`,
        detail: `@${personalAccount.username}`,
        avatarUrl: personalAccount.avatarUrl,
        coauthored: false,
        icon: () => <IconUserRound class="size-4" />,
      },
    ];

    for (const membership of actingAccount.organizations()) {
      const organization = membership.organization;
      options.push({
        value: organizationComposeAccountKey(
          organization.id,
          "ACTING_ACCOUNT_ONLY",
        ),
        accountId: organization.id,
        attributionMode: "ACTING_ACCOUNT_ONLY",
        label: organization.name || organization.username,
        detail: `@${organization.username}`,
        avatarUrl: organization.avatarUrl,
        coauthored: false,
        icon: () => <IconBuilding2 class="size-4" />,
      });
      options.push({
        value: organizationComposeAccountKey(
          organization.id,
          "ACTING_ACCOUNT_WITH_VIEWER",
        ),
        accountId: organization.id,
        attributionMode: "ACTING_ACCOUNT_WITH_VIEWER",
        label: organization.name || organization.username,
        detail: t`Co-author`,
        avatarUrl: organization.avatarUrl,
        coauthored: true,
        icon: () => <IconUsers class="size-4" />,
      });
    }

    return options;
  });
}

export function ActingAccountSelect(props: ActingAccountSelectProps) {
  const { t } = useLingui();
  const options = useComposeActingAccountOptions();
  const selectedOption = () =>
    options().find((option) => option.value === props.value) ?? options()[0];

  return (
    <Select
      value={selectedOption()}
      onChange={(option) =>
        props.onChange(option?.value ?? PERSONAL_COMPOSE_ACCOUNT_KEY)}
      options={options()}
      optionValue="value"
      optionTextValue="label"
      disabled={props.disabled || options().length < 2}
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          <AccountOption option={props.item.rawValue} />
        </SelectItem>
      )}
    >
      <SelectTrigger
        aria-label={t`Author`}
        class={cn("w-full sm:w-[260px]", props.class)}
      >
        <SelectValue<ComposeActingAccountOption>>
          {(state) => (
            <div class="flex min-w-0 items-center gap-2">
              {state.selectedOption().icon()}
              <span class="min-w-0 truncate">
                {state.selectedOption().label}
              </span>
              <Show when={state.selectedOption().coauthored}>
                <span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                  {t`Co-author`}
                </span>
              </Show>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent class="min-w-64" />
    </Select>
  );
}

function AccountOption(props: { option: ComposeActingAccountOption }) {
  return (
    <div class="flex min-w-0 items-center gap-2">
      <Avatar class="size-6">
        <AvatarImage src={props.option.avatarUrl ?? undefined} />
        <AvatarFallback class="text-xs">
          {props.option.label.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div class="min-w-0">
        <div class="truncate">{props.option.label}</div>
        <div class="truncate text-xs text-muted-foreground">
          {props.option.detail}
        </div>
      </div>
    </div>
  );
}

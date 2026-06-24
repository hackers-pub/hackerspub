import type { Accessor } from "solid-js";
import { createMemo } from "solid-js";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import {
  Select,
  SelectContent,
  SelectDescription,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import {
  type ActingAccountSummary,
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
  accounts: readonly ActingAccountSummary[];
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
  const actingAccount = useActingAccount();

  return createMemo(() => {
    const personalAccount = actingAccount.personalAccount();
    if (personalAccount == null) return [];

    const options: ComposeActingAccountOption[] = [
      {
        value: PERSONAL_COMPOSE_ACCOUNT_KEY,
        label: formatAccountsLabel([personalAccount]),
        accounts: [personalAccount],
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
        label: formatAccountsLabel([organization]),
        accounts: [organization],
      });
      options.push({
        value: organizationComposeAccountKey(
          organization.id,
          "ACTING_ACCOUNT_WITH_VIEWER",
        ),
        accountId: organization.id,
        attributionMode: "ACTING_ACCOUNT_WITH_VIEWER",
        label: formatAccountsLabel([organization, personalAccount]),
        accounts: [organization, personalAccount],
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
        <SelectItem item={props.item} class="min-w-0 overflow-hidden">
          <AccountOption option={props.item.rawValue} />
        </SelectItem>
      )}
    >
      <SelectTrigger
        aria-label={t`Author`}
        class={cn("w-full overflow-hidden text-left sm:w-[340px]", props.class)}
      >
        <SelectValue<ComposeActingAccountOption>
          class="min-w-0 flex-1 overflow-hidden"
        >
          {(state) => (
            <div class="flex w-full min-w-0 items-center gap-2 overflow-hidden">
              <AccountAvatarStack
                accounts={state.selectedOption().accounts}
                size="sm"
              />
              <AccountIdentityList
                accounts={state.selectedOption().accounts}
                class="flex-1 text-left"
              />
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectDescription class="max-w-full text-left leading-6 sm:max-w-[340px]">
        {t`Choose the account or co-authors shown on this post.`}
      </SelectDescription>
      <SelectContent class="w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-x-hidden" />
    </Select>
  );
}

function AccountOption(props: { option: ComposeActingAccountOption }) {
  return (
    <div class="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden py-0.5">
      <AccountAvatarStack accounts={props.option.accounts} size="md" />
      <AccountOptionIdentity accounts={props.option.accounts} />
    </div>
  );
}

function formatAccountLabel(account: ActingAccountSummary): string {
  return `${formatAccountName(account)} (${formatAccountHandle(account)})`;
}

function formatAccountsLabel(
  accounts: readonly ActingAccountSummary[],
): string {
  return accounts.map(formatAccountLabel).join(" + ");
}

function formatAccountName(account: ActingAccountSummary): string {
  return account.name || account.username;
}

function formatAccountHandle(account: ActingAccountSummary): string {
  return `@${account.username}`;
}

function AccountAvatarStack(props: {
  accounts: readonly ActingAccountSummary[];
  size: "sm" | "md";
}) {
  const avatarSize = () => props.size === "sm" ? "size-5" : "size-6";
  return (
    <div class="flex shrink-0 -space-x-1" aria-hidden="true">
      {props.accounts.map((account) => (
        <Avatar class={cn(avatarSize(), "border border-background")}>
          <AvatarImage
            src={account.avatarUrl ?? undefined}
            alt=""
          />
          <AvatarFallback class="text-[0.625rem] font-medium">
            {formatAccountName(account).charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      ))}
    </div>
  );
}

function AccountIdentityList(props: {
  accounts: readonly ActingAccountSummary[];
  class?: string;
}) {
  return (
    <span class={cn("block min-w-0 max-w-full truncate", props.class)}>
      <span class="sr-only">{formatAccountsLabel(props.accounts)}</span>
      <span aria-hidden="true">
        {props.accounts.map((account, index) => (
          <>
            {index > 0 && <span class="mx-1 text-muted-foreground">+</span>}
            <span>{formatAccountName(account)}</span>{" "}
            <span class="text-muted-foreground">
              ({formatAccountHandle(account)})
            </span>
          </>
        ))}
      </span>
    </span>
  );
}

function AccountOptionIdentity(props: {
  accounts: readonly ActingAccountSummary[];
}) {
  return (
    <div class="min-w-0 max-w-full flex-1 overflow-hidden">
      <div class="min-w-0 max-w-full truncate">
        <span class="sr-only">{formatAccountsLabel(props.accounts)}</span>
        <span aria-hidden="true">
          {props.accounts.map((account, index) => (
            <>
              {index > 0 && <span class="mx-1 text-muted-foreground">+</span>}
              <span>{formatAccountName(account)}</span>
            </>
          ))}
        </span>
      </div>
      <div
        class="min-w-0 max-w-full truncate text-xs text-muted-foreground"
        aria-hidden="true"
      >
        {props.accounts.map((account, index) => (
          <>
            {index > 0 && <span class="mx-1">+</span>}
            <span>{formatAccountHandle(account)}</span>
          </>
        ))}
      </div>
    </div>
  );
}

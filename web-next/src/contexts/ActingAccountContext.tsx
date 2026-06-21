import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  type ParentComponent,
  useContext,
} from "solid-js";
import { isServer } from "solid-js/web";

const STORAGE_KEY = "hackerspub:acting-account";

export const PERSONAL_ACTING_ACCOUNT_KEY = "personal";
export const PERSONAL_COMPOSE_ACCOUNT_KEY = "personal";

export type PostAttributionMode =
  | "ACTING_ACCOUNT_ONLY"
  | "ACTING_ACCOUNT_WITH_VIEWER";

export interface ActingAccountSummary {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string | null;
}

export interface OrganizationNotificationBadge {
  color?: string | null;
  count: number;
}

export interface ActingOrganizationMembership {
  role: "ADMIN" | "MEMBER" | string;
  notificationBadge?: OrganizationNotificationBadge | null;
  organization: ActingAccountSummary;
}

export interface ComposeActingAccountInput {
  actingAccountId?: string;
  attributionMode?: PostAttributionMode;
}

interface ActingAccountContextValue {
  personalAccount: () => ActingAccountSummary | null;
  organizations: () => readonly ActingOrganizationMembership[];
  selectedKey: () => string;
  selectedOrganization: () => ActingOrganizationMembership | null;
  selectedActingAccountId: () => string | undefined;
  setSelectedKey: (key: string) => void;
  setAccounts: (
    personalAccount: ActingAccountSummary | null,
    organizations: readonly ActingOrganizationMembership[],
  ) => void;
  defaultComposeAccountKey: () => string;
  composeInputForKey: (key: string) => ComposeActingAccountInput;
}

const ActingAccountContext = createContext<ActingAccountContextValue>();

export function organizationActingAccountKey(accountId: string): string {
  return `organization:${accountId}`;
}

export function organizationComposeAccountKey(
  accountId: string,
  attributionMode: PostAttributionMode,
): string {
  const suffix = attributionMode === "ACTING_ACCOUNT_WITH_VIEWER"
    ? "coauthor"
    : "only";
  return `${organizationActingAccountKey(accountId)}:${suffix}`;
}

function parseOrganizationActingAccountKey(key: string): string | null {
  const match = /^organization:(.+)$/.exec(key);
  return match?.[1] ?? null;
}

function parseOrganizationComposeAccountKey(
  key: string,
): ComposeActingAccountInput | null {
  const match = /^organization:(.+):(only|coauthor)$/.exec(key);
  if (match == null) return null;
  return {
    actingAccountId: match[1],
    attributionMode: match[2] === "coauthor"
      ? "ACTING_ACCOUNT_WITH_VIEWER"
      : "ACTING_ACCOUNT_ONLY",
  };
}

export const ActingAccountProvider: ParentComponent = (props) => {
  const [personalAccount, setPersonalAccount] = createSignal<
    ActingAccountSummary | null
  >(null);
  const [organizations, setOrganizations] = createSignal<
    readonly ActingOrganizationMembership[]
  >([]);
  const [selectedKeySignal, setSelectedKeySignal] = createSignal(
    PERSONAL_ACTING_ACCOUNT_KEY,
  );
  const [storageLoaded, setStorageLoaded] = createSignal(isServer);

  const validSelectedKeys = createMemo(() => {
    const keys = new Set<string>([PERSONAL_ACTING_ACCOUNT_KEY]);
    for (const membership of organizations()) {
      keys.add(organizationActingAccountKey(membership.organization.id));
    }
    return keys;
  });

  const persistSelectedKey = (key: string) => {
    if (isServer) return;
    localStorage.setItem(STORAGE_KEY, key);
  };

  const setSelectedKey = (key: string) => {
    const nextKey = validSelectedKeys().has(key)
      ? key
      : PERSONAL_ACTING_ACCOUNT_KEY;
    setSelectedKeySignal(nextKey);
    persistSelectedKey(nextKey);
  };

  createEffect(() => {
    if (!storageLoaded() || personalAccount() == null) return;
    const key = selectedKeySignal();
    if (!validSelectedKeys().has(key)) {
      setSelectedKeySignal(PERSONAL_ACTING_ACCOUNT_KEY);
      persistSelectedKey(PERSONAL_ACTING_ACCOUNT_KEY);
    }
  });

  onMount(() => {
    if (!isServer) {
      const storedKey = localStorage.getItem(STORAGE_KEY);
      if (storedKey != null) setSelectedKeySignal(storedKey);
      setStorageLoaded(true);
    }
  });

  const selectedOrganization = createMemo(() => {
    const accountId = parseOrganizationActingAccountKey(selectedKeySignal());
    if (accountId == null) return null;
    return organizations().find((membership) =>
      membership.organization.id === accountId
    ) ?? null;
  });

  const defaultComposeAccountKey = () => {
    const membership = selectedOrganization();
    if (membership == null) return PERSONAL_COMPOSE_ACCOUNT_KEY;
    return organizationComposeAccountKey(
      membership.organization.id,
      "ACTING_ACCOUNT_ONLY",
    );
  };

  const composeInputForKey = (key: string): ComposeActingAccountInput => {
    if (key === PERSONAL_COMPOSE_ACCOUNT_KEY) return {};
    const parsed = parseOrganizationComposeAccountKey(key);
    if (parsed == null) return {};
    const isValid = organizations().some((membership) =>
      membership.organization.id === parsed.actingAccountId
    );
    return isValid ? parsed : {};
  };

  return (
    <ActingAccountContext.Provider
      value={{
        personalAccount,
        organizations,
        selectedKey: selectedKeySignal,
        selectedOrganization,
        selectedActingAccountId: () => selectedOrganization()?.organization.id,
        setSelectedKey,
        setAccounts: (personalAccount, organizations) => {
          setPersonalAccount(personalAccount);
          setOrganizations(organizations);
        },
        defaultComposeAccountKey,
        composeInputForKey,
      }}
    >
      {props.children}
    </ActingAccountContext.Provider>
  );
};

export function useActingAccount() {
  const context = useContext(ActingAccountContext);
  if (!context) {
    throw new Error(
      "useActingAccount must be used within an ActingAccountProvider",
    );
  }
  return context;
}

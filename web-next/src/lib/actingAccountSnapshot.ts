import type {
  ActingAccountSummary,
  ActingOrganizationMembership,
  OrganizationNotificationBadge,
} from "~/contexts/ActingAccountContext.tsx";

export interface OrganizationMembershipSnapshot {
  readonly role?: string;
  readonly notificationBadge?: OrganizationNotificationBadge | null;
  readonly organization?: {
    readonly id?: string;
    readonly name?: string;
    readonly username?: string;
    readonly avatarUrl?: string | null;
  } | null;
}

export interface AccountSummarySnapshot {
  readonly id?: string;
  readonly name?: string;
  readonly username?: string;
  readonly avatarUrl?: string | null;
}

export function getCompleteActingAccount(
  account: AccountSummarySnapshot,
): ActingAccountSummary | null {
  if (
    typeof account.id !== "string" ||
    typeof account.name !== "string" ||
    typeof account.username !== "string"
  ) {
    return null;
  }
  return {
    id: account.id,
    name: account.name,
    username: account.username,
    avatarUrl: account.avatarUrl,
  };
}

export function getCompleteActingOrganizations(
  memberships: readonly (OrganizationMembershipSnapshot | null | undefined)[],
): readonly ActingOrganizationMembership[] | null {
  const organizations: ActingOrganizationMembership[] = [];
  for (const membership of memberships) {
    const organization = membership?.organization;
    if (
      membership == null ||
      organization == null ||
      typeof membership.role !== "string" ||
      typeof organization.id !== "string" ||
      typeof organization.name !== "string" ||
      typeof organization.username !== "string"
    ) {
      return null;
    }
    organizations.push({
      role: membership.role,
      notificationBadge: membership.notificationBadge,
      organization: {
        id: organization.id,
        name: organization.name,
        username: organization.username,
        avatarUrl: organization.avatarUrl,
      },
    });
  }
  return organizations;
}

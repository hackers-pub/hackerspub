import { type RouteDefinition, useParams } from "@solidjs/router";
import { debounce } from "es-toolkit";
import { fetchQuery, graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import IconCheck from "~icons/lucide/check";
import IconPlus from "~icons/lucide/plus";
import IconTrash2 from "~icons/lucide/trash-2";
import IconUserMinus from "~icons/lucide/user-minus";
import IconUserPlus from "~icons/lucide/user-plus";
import IconUsers from "~icons/lucide/users";
import {
  ActorHandleAutocomplete,
  type ActorHandleAutocompleteActor,
} from "~/components/ActorHandleAutocomplete.tsx";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import {
  Select,
  SelectContent,
  SelectDescription,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { removeSessionCookie } from "~/lib/sessionActions.ts";
import type { accountAddMigrationAliasMutation } from "./__generated__/accountAddMigrationAliasMutation.graphql.ts";
import type { accountAcceptOrganizationInvitationMutation } from "./__generated__/accountAcceptOrganizationInvitationMutation.graphql.ts";
import type { accountCreateOrganizationMutation } from "./__generated__/accountCreateOrganizationMutation.graphql.ts";
import type { accountDeleteMutation } from "./__generated__/accountDeleteMutation.graphql.ts";
import type { accountInviteOrganizationMemberMutation } from "./__generated__/accountInviteOrganizationMemberMutation.graphql.ts";
import type { accountOrganizationConversionAdminLookupQuery } from "./__generated__/accountOrganizationConversionAdminLookupQuery.graphql.ts";
import type { accountLeaveOrganizationMutation } from "./__generated__/accountLeaveOrganizationMutation.graphql.ts";
import type { accountOrganizationMembersQuery } from "./__generated__/accountOrganizationMembersQuery.graphql.ts";
import type { accountPageQuery } from "./__generated__/accountPageQuery.graphql.ts";
import type { accountRemoveMigrationAliasMutation } from "./__generated__/accountRemoveMigrationAliasMutation.graphql.ts";
import type { accountRemoveOrganizationMemberMutation } from "./__generated__/accountRemoveOrganizationMemberMutation.graphql.ts";
import type { accountRequestOrganizationConversionMutation } from "./__generated__/accountRequestOrganizationConversionMutation.graphql.ts";
import type { accountUpdateOrganizationMemberRoleMutation } from "./__generated__/accountUpdateOrganizationMemberRoleMutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const accountPageQuery = graphql`
  query accountPageQuery($username: String!) {
    viewer {
      id
      username
      invitationsLeft
      organizationMemberships {
        role
        organization {
          id
          username
          name
          avatarUrl
        }
      }
      organizationInvitations {
        role
        organization {
          id
          username
          name
          avatarUrl
        }
      }
    }
    accountByUsername(username: $username) {
      id
      username
      kind
      viewerCanManageSettings
      actor {
        aliases
      }
      ...SettingsTabs_account
    }
  }
`;

const loadAccountPageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<accountPageQuery>(
      useRelayEnvironment()(),
      accountPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadAccountPageQuery",
);

const accountDeleteMutation = graphql`
  mutation accountDeleteMutation($id: ID!) {
    deleteAccount(input: { id: $id }) {
      __typename
      ... on DeleteAccountPayload {
        deletedAccountId
        username
        deleted
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on AccountDeletionUnavailableError {
        unavailable
      }
    }
  }
`;

const accountAddMigrationAliasMutation = graphql`
  mutation accountAddMigrationAliasMutation($accountId: ID!, $actor: String!) {
    addAccountMigrationAlias(
      input: { accountId: $accountId, actor: $actor }
    ) {
      __typename
      ... on AddAccountMigrationAliasPayload {
        account {
          id
          actor {
            id
            aliases
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

const accountRemoveMigrationAliasMutation = graphql`
  mutation accountRemoveMigrationAliasMutation($accountId: ID!, $alias: URL!) {
    removeAccountMigrationAlias(
      input: { accountId: $accountId, alias: $alias }
    ) {
      __typename
      ... on RemoveAccountMigrationAliasPayload {
        account {
          id
          actor {
            id
            aliases
          }
        }
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

const accountOrganizationMembersQuery = graphql`
  query accountOrganizationMembersQuery($username: String!) {
    accountByUsername(username: $username) {
      id
      organizationMembers {
        role
        member {
          id
          username
          name
          avatarUrl
        }
      }
    }
  }
`;

const accountCreateOrganizationMutation = graphql`
  mutation accountCreateOrganizationMutation($input: CreateOrganizationInput!) {
    createOrganization(input: $input) {
      __typename
      ... on CreateOrganizationPayload {
        organization {
          id
          username
        }
      }
      ... on OrganizationInvitationRequiredError {
        message
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountInviteOrganizationMemberMutation = graphql`
  mutation accountInviteOrganizationMemberMutation(
    $organizationId: ID!
    $username: String!
    $role: OrganizationMemberRole
  ) {
    inviteOrganizationMember(
      input: {
        organizationId: $organizationId
        username: $username
        role: $role
      }
    ) {
      __typename
      ... on InviteOrganizationMemberPayload {
        membership {
          role
          member {
            username
          }
        }
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountAcceptOrganizationInvitationMutation = graphql`
  mutation accountAcceptOrganizationInvitationMutation($organizationId: ID!) {
    acceptOrganizationInvitation(input: { organizationId: $organizationId }) {
      __typename
      ... on AcceptOrganizationInvitationPayload {
        membership {
          role
          organization {
            username
          }
        }
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountLeaveOrganizationMutation = graphql`
  mutation accountLeaveOrganizationMutation($organizationId: ID!) {
    leaveOrganization(input: { organizationId: $organizationId }) {
      __typename
      ... on LeaveOrganizationPayload {
        membership {
          organization {
            username
          }
        }
      }
      ... on LastOrganizationMemberError {
        message
      }
      ... on LastOrganizationAdminError {
        message
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountRequestOrganizationConversionMutation = graphql`
  mutation accountRequestOrganizationConversionMutation(
    $accountId: ID!
    $adminUsername: String!
    $confirmationUsername: String!
  ) {
    requestOrganizationConversion(
      input: {
        accountId: $accountId
        adminUsername: $adminUsername
        confirmationUsername: $confirmationUsername
      }
    ) {
      __typename
      ... on RequestOrganizationConversionPayload {
        request {
          admin {
            username
          }
        }
      }
      ... on OrganizationConversionError {
        message
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountOrganizationConversionAdminLookupQuery = graphql`
  query accountOrganizationConversionAdminLookupQuery($username: String!) {
    accountByUsername(username: $username) {
      id
      username
      name
      avatarUrl
      kind
    }
  }
`;

const accountUpdateOrganizationMemberRoleMutation = graphql`
  mutation accountUpdateOrganizationMemberRoleMutation(
    $organizationId: ID!
    $memberId: ID!
    $role: OrganizationMemberRole!
  ) {
    updateOrganizationMemberRole(
      input: {
        organizationId: $organizationId
        memberId: $memberId
        role: $role
      }
    ) {
      __typename
      ... on UpdateOrganizationMemberRolePayload {
        membership {
          role
          member {
            username
          }
        }
      }
      ... on LastOrganizationAdminError {
        message
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const accountRemoveOrganizationMemberMutation = graphql`
  mutation accountRemoveOrganizationMemberMutation(
    $organizationId: ID!
    $memberId: ID!
  ) {
    removeOrganizationMember(
      input: { organizationId: $organizationId, memberId: $memberId }
    ) {
      __typename
      ... on RemoveOrganizationMemberPayload {
        membership {
          member {
            username
          }
        }
      }
      ... on LastOrganizationMemberError {
        message
      }
      ... on LastOrganizationAdminError {
        message
      }
      ... on OrganizationMembershipError {
        message
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

type AccountPageAccount = NonNullable<
  accountPageQuery["response"]["accountByUsername"]
>;

type OrganizationConversionAdminAccount = NonNullable<
  accountOrganizationConversionAdminLookupQuery["response"]["accountByUsername"]
>;

type AccountPageViewer = NonNullable<accountPageQuery["response"]["viewer"]>;

export default function AccountSettingsPage() {
  const params = useParams();
  const { t } = useLingui();
  const data = createStablePreloadedQuery<accountPageQuery>(
    accountPageQuery,
    () => loadAccountPageQuery(decodeRouteParam(params.handle!)),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          canManageSettings={data.accountByUsername?.viewerCanManageSettings}
          viewerId={data.viewer?.id}
        >
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Account settings`}</Title>
                <SettingsContainer class="p-4">
                  <h1 class="sr-only">{t`Account settings`}</h1>
                  <SettingsTabs selected="account" $account={account} />
                  <div class="mt-4 flex flex-col gap-4">
                    <Switch>
                      <Match when={account.kind === "PERSONAL"}>
                        <Show keyed when={data.viewer}>
                          {(viewer) => (
                            <>
                              <PersonalOrganizationCards
                                account={account}
                                viewer={viewer}
                              />
                              <Card>
                                <CardHeader>
                                  <CardTitle>
                                    {t`Account migration`}
                                  </CardTitle>
                                  <CardDescription>
                                    {t`Prepare this account as the destination for a Mastodon-style move.`}
                                  </CardDescription>
                                </CardHeader>
                                <CardContent>
                                  <AccountMigrationAliasesForm
                                    id={account.id}
                                    aliases={account.actor.aliases}
                                  />
                                </CardContent>
                              </Card>
                              <Card>
                                <CardHeader>
                                  <CardTitle>{t`Delete account`}</CardTitle>
                                  <CardDescription>
                                    {t`Permanently delete your account and sign out of this session.`}
                                  </CardDescription>
                                </CardHeader>
                                <CardContent>
                                  <AccountDeletionForm
                                    id={account.id}
                                    username={account.username}
                                  />
                                </CardContent>
                              </Card>
                            </>
                          )}
                        </Show>
                      </Match>
                      <Match when={account.kind === "ORGANIZATION"}>
                        <OrganizationMemberManagementCard account={account} />
                        <Card>
                          <CardHeader>
                            <CardTitle>{t`Delete organization`}</CardTitle>
                            <CardDescription>
                              {t`Permanently delete this organization account and its content.`}
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <AccountDeletionForm
                              id={account.id}
                              kind="organization"
                              username={account.username}
                            />
                          </CardContent>
                        </Card>
                      </Match>
                    </Switch>
                  </div>
                </SettingsContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

type OrganizationMemberRole = "ADMIN" | "MEMBER";

const ORGANIZATION_ROLE_OPTIONS: OrganizationMemberRole[] = [
  "MEMBER",
  "ADMIN",
];

type OrganizationMembershipSummary =
  AccountPageViewer["organizationMemberships"][number];

type OrganizationInvitationSummary =
  AccountPageViewer["organizationInvitations"][number];

type OrganizationMemberRow = NonNullable<
  accountOrganizationMembersQuery["response"]["accountByUsername"]
>["organizationMembers"][number];

type LocalAutocompleteAccount = NonNullable<
  ActorHandleAutocompleteActor["account"]
>;

function roleBadgeVariant(role: string): "secondary" | "outline" {
  return role === "ADMIN" ? "secondary" : "outline";
}

function OrganizationIdentity(props: {
  avatarUrl?: string | null;
  name: string;
  username: string;
}) {
  return (
    <div class="flex min-w-0 items-center gap-3">
      <Avatar class="size-9">
        <AvatarImage src={props.avatarUrl ?? undefined} />
        <AvatarFallback class="text-sm">
          {props.name.charAt(0).toUpperCase() ||
            props.username.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">
          {props.name || props.username}
        </p>
        <p class="truncate text-xs text-muted-foreground">
          @{props.username}
        </p>
      </div>
    </div>
  );
}

function PersonalOrganizationCards(props: {
  account: AccountPageAccount;
  viewer: AccountPageViewer;
}) {
  const { t } = useLingui();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t`Create organization`}</CardTitle>
          <CardDescription>
            {t`Create an organization account that shares the username namespace and consumes one invitation.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm
            invitationsLeft={props.viewer.invitationsLeft}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t`Organization invitations`}</CardTitle>
          <CardDescription>
            {t`Accept pending invitations from organization administrators.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationInvitationList
            invitations={props.viewer.organizationInvitations}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t`Your organizations`}</CardTitle>
          <CardDescription>
            {t`Leave organizations you no longer work with. The last member or last admin cannot leave.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationMembershipList
            memberships={props.viewer.organizationMemberships}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t`Convert to organization`}</CardTitle>
          <CardDescription>
            {t`Turn this personal account into an organization account. This cannot be undone.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationConversionForms account={props.account} />
        </CardContent>
      </Card>
    </>
  );
}

function CreateOrganizationForm(props: { invitationsLeft: number }) {
  const { t } = useLingui();
  const [username, setUsername] = createSignal("");
  const [name, setName] = createSignal("");
  const [bio, setBio] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [createOrganization] = createMutation<
    accountCreateOrganizationMutation
  >(accountCreateOrganizationMutation);
  const canCreate = createMemo(() =>
    props.invitationsLeft > 0 &&
    username().trim() !== "" &&
    name().trim() !== "" &&
    !creating()
  );

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!canCreate()) return;
    setCreating(true);
    createOrganization({
      variables: {
        input: {
          username: username().trim(),
          name: name().trim(),
          bio: bio().trim(),
        },
      },
      onCompleted(response) {
        setCreating(false);
        const result = response.createOrganization;
        if (result?.__typename === "CreateOrganizationPayload") {
          showToast({
            title: t`Organization created`,
            description: t`You are now an admin of the new organization.`,
          });
          location.assign(`/@${result.organization.username}/settings/account`);
          return;
        }
        showToast({
          title: t`Could not create organization`,
          description: result != null && "message" in result
            ? result.message
            : t`Check the username and your remaining invitations, then try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setCreating(false);
        showToast({
          title: t`Could not create organization`,
          description:
            t`The organization could not be created. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <form class="flex flex-col gap-4" onSubmit={onSubmit}>
      <div class="rounded-md border p-3 text-sm text-muted-foreground">
        {t`You have ${props.invitationsLeft} invitations available.`}
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <TextField
          value={username()}
          onChange={setUsername}
          validationState={props.invitationsLeft > 0 ? "valid" : "invalid"}
        >
          <TextFieldLabel>{t`Username`}</TextFieldLabel>
          <TextFieldInput
            autocomplete="off"
            autocapitalize="none"
            disabled={creating() || props.invitationsLeft <= 0}
            placeholder={t`team-name`}
          />
          <TextFieldDescription>
            {t`Used for the profile URL and WebFinger handle.`}
          </TextFieldDescription>
        </TextField>
        <TextField value={name()} onChange={setName}>
          <TextFieldLabel>{t`Display name`}</TextFieldLabel>
          <TextFieldInput
            autocomplete="off"
            disabled={creating() || props.invitationsLeft <= 0}
            placeholder={t`Team name`}
          />
        </TextField>
      </div>
      <TextField value={bio()} onChange={setBio}>
        <TextFieldLabel>{t`Description`}</TextFieldLabel>
        <TextFieldTextArea
          disabled={creating() || props.invitationsLeft <= 0}
          rows={3}
        />
      </TextField>
      <div>
        <Button type="submit" disabled={!canCreate()}>
          <IconPlus />
          {creating() ? t`Creating…` : t`Create organization`}
        </Button>
      </div>
    </form>
  );
}

function OrganizationInvitationList(props: {
  invitations: readonly OrganizationInvitationSummary[];
}) {
  const { t } = useLingui();
  const roleLabel = (role: string) =>
    role === "ADMIN" ? t`Organization admin` : t`Member`;
  const [acceptingId, setAcceptingId] = createSignal<string | null>(null);
  const [acceptInvitation] = createMutation<
    accountAcceptOrganizationInvitationMutation
  >(accountAcceptOrganizationInvitationMutation);

  function onAccept(invitation: OrganizationInvitationSummary) {
    if (acceptingId() != null) return;
    setAcceptingId(invitation.organization.id);
    acceptInvitation({
      variables: { organizationId: invitation.organization.id },
      onCompleted(response) {
        setAcceptingId(null);
        const result = response.acceptOrganizationInvitation;
        if (result?.__typename === "AcceptOrganizationInvitationPayload") {
          showToast({
            title: t`Invitation accepted`,
            description:
              t`You can now act as ${result.membership.organization.username}.`,
          });
          location.reload();
          return;
        }
        showToast({
          title: t`Could not accept invitation`,
          description: result != null && "message" in result
            ? result.message
            : t`The invitation could not be accepted. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setAcceptingId(null);
        showToast({
          title: t`Could not accept invitation`,
          description:
            t`The invitation could not be accepted. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <Show
      when={props.invitations.length > 0}
      fallback={
        <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t`No pending organization invitations.`}
        </p>
      }
    >
      <div class="overflow-hidden rounded-md border">
        <For each={props.invitations}>
          {(invitation) => (
            <div class="flex flex-col gap-3 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
              <OrganizationIdentity
                avatarUrl={invitation.organization.avatarUrl}
                name={invitation.organization.name}
                username={invitation.organization.username}
              />
              <div class="flex shrink-0 items-center gap-2">
                <Badge variant={roleBadgeVariant(invitation.role)} round>
                  {roleLabel(invitation.role)}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  disabled={acceptingId() != null}
                  onClick={() => onAccept(invitation)}
                >
                  <IconCheck />
                  {acceptingId() === invitation.organization.id
                    ? t`Accepting…`
                    : t`Accept`}
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function OrganizationMembershipList(props: {
  memberships: readonly OrganizationMembershipSummary[];
}) {
  const { t } = useLingui();
  const roleLabel = (role: string) =>
    role === "ADMIN" ? t`Organization admin` : t`Member`;
  const [leavingId, setLeavingId] = createSignal<string | null>(null);
  const [leaveOrganization] = createMutation<accountLeaveOrganizationMutation>(
    accountLeaveOrganizationMutation,
  );

  function onLeave(membership: OrganizationMembershipSummary) {
    if (leavingId() != null) return;
    setLeavingId(membership.organization.id);
    leaveOrganization({
      variables: { organizationId: membership.organization.id },
      onCompleted(response) {
        setLeavingId(null);
        const result = response.leaveOrganization;
        if (result?.__typename === "LeaveOrganizationPayload") {
          showToast({
            title: t`Left organization`,
            description: t`You no longer belong to that organization.`,
          });
          location.reload();
          return;
        }
        showToast({
          title: t`Could not leave organization`,
          description: result != null && "message" in result
            ? result.message
            : t`The organization could not be left. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setLeavingId(null);
        showToast({
          title: t`Could not leave organization`,
          description:
            t`The organization could not be left. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <Show
      when={props.memberships.length > 0}
      fallback={
        <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t`You do not belong to any organizations yet.`}
        </p>
      }
    >
      <div class="overflow-hidden rounded-md border">
        <For each={props.memberships}>
          {(membership) => (
            <div class="flex flex-col gap-3 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
              <OrganizationIdentity
                avatarUrl={membership.organization.avatarUrl}
                name={membership.organization.name}
                username={membership.organization.username}
              />
              <div class="flex shrink-0 items-center gap-2">
                <Badge variant={roleBadgeVariant(membership.role)} round>
                  {roleLabel(membership.role)}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={leavingId() != null}
                  onClick={() => onLeave(membership)}
                >
                  <IconUserMinus />
                  {leavingId() === membership.organization.id
                    ? t`Leaving…`
                    : t`Leave`}
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function accountAvatarInitials(account: {
  readonly name: string;
  readonly username: string;
}) {
  const name = (account.name.trim() || account.username).trim();
  const parts = name.split(/[\s_-]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function OrganizationConversionForms(props: { account: AccountPageAccount }) {
  const { t } = useLingui();
  const environment = useRelayEnvironment();
  const [adminUsername, setAdminUsername] = createSignal("");
  const [selectedAdmin, setSelectedAdmin] = createSignal<
    OrganizationConversionAdminAccount | null
  >(null);
  const [confirmation, setConfirmation] = createSignal("");
  const [requesting, setRequesting] = createSignal(false);
  const [requestConversion] = createMutation<
    accountRequestOrganizationConversionMutation
  >(accountRequestOrganizationConversionMutation);
  let adminLookupRequest = 0;
  const lookupAdmin = debounce((username: string, requestId: number) => {
    fetchQuery<accountOrganizationConversionAdminLookupQuery>(
      environment(),
      accountOrganizationConversionAdminLookupQuery,
      { username },
    ).subscribe({
      next(data) {
        if (requestId !== adminLookupRequest) return;
        const account = data.accountByUsername;
        setSelectedAdmin(account?.kind === "PERSONAL" ? account : null);
      },
      error() {
        if (requestId !== adminLookupRequest) return;
        setSelectedAdmin(null);
      },
    });
  }, 150);
  const canRequest = createMemo(() =>
    adminUsername().trim() !== "" &&
    confirmation().trim().toLowerCase() ===
      props.account.username.toLowerCase() &&
    !requesting()
  );

  function onAdminUsernameInput(value: string) {
    const username = value.trim().replace(/^@/, "");
    setAdminUsername(username);
    adminLookupRequest += 1;
    lookupAdmin.cancel();
    if (username === "") {
      setSelectedAdmin(null);
      return;
    }
    lookupAdmin(username, adminLookupRequest);
  }

  function selectAdminAccount(account: OrganizationConversionAdminAccount) {
    adminLookupRequest += 1;
    lookupAdmin.cancel();
    setAdminUsername(account.username);
    setSelectedAdmin(account);
  }

  function selectedAdminAvatar() {
    const admin = selectedAdmin();
    if (admin == null) return undefined;
    return (
      <Avatar class="size-6">
        <AvatarImage src={admin.avatarUrl} />
        <AvatarFallback class="text-[10px]">
          {accountAvatarInitials(admin)}
        </AvatarFallback>
      </Avatar>
    );
  }

  onCleanup(() => lookupAdmin.cancel());

  function onRequest(event: SubmitEvent) {
    event.preventDefault();
    if (!canRequest()) return;
    setRequesting(true);
    requestConversion({
      variables: {
        accountId: props.account.id,
        adminUsername: adminUsername().trim(),
        confirmationUsername: confirmation().trim(),
      },
      onCompleted(response) {
        setRequesting(false);
        const result = response.requestOrganizationConversion;
        if (result?.__typename === "RequestOrganizationConversionPayload") {
          showToast({
            title: t`Conversion request created`,
            description:
              t`${result.request.admin.username} will receive a notification to review it.`,
          });
          return;
        }
        showToast({
          title: t`Could not request conversion`,
          description: result != null && "message" in result
            ? result.message
            : t`Check the admin username and confirmation, then try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setRequesting(false);
        showToast({
          title: t`Could not request conversion`,
          description:
            t`The conversion request could not be created. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <div class="flex flex-col gap-6">
      <div class="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm">
        <p class="font-medium text-destructive">
          {t`This action is permanent.`}
        </p>
        <p class="mt-2 text-muted-foreground">
          {t`After conversion, this account cannot sign in directly and cannot be converted back to a personal account.`}
        </p>
      </div>

      <form class="flex flex-col gap-4" onSubmit={onRequest}>
        <div class="grid gap-4 sm:grid-cols-2">
          <ActorHandleAutocomplete
            inputId="organization-conversion-admin-username"
            label={t`New admin username`}
            placeholder={t`username`}
            value={adminUsername()}
            disabled={requesting()}
            localAccountsOnly
            accountKind="PERSONAL"
            suggestionIdentifier="username"
            leading={selectedAdminAvatar()}
            description={t`This personal account will accept the request and become the first organization admin.`}
            onInput={onAdminUsernameInput}
            onSelect={(actor) => {
              const account = actor.account;
              if (account == null || account.kind !== "PERSONAL") return;
              selectAdminAccount(account);
            }}
          />
          <TextField value={confirmation()} onChange={setConfirmation}>
            <TextFieldLabel>{t`Current username`}</TextFieldLabel>
            <TextFieldInput
              autocomplete="off"
              autocapitalize="none"
              disabled={requesting()}
              placeholder={props.account.username}
            />
            <TextFieldDescription>
              {t`Type ${props.account.username} to confirm conversion.`}
            </TextFieldDescription>
          </TextField>
        </div>
        <div>
          <Button type="submit" variant="destructive" disabled={!canRequest()}>
            <IconUsers />
            {requesting() ? t`Requesting…` : t`Request conversion`}
          </Button>
        </div>
        <p class="text-sm text-muted-foreground">
          {t`The accepting admin will receive a notification with a review link.`}
        </p>
      </form>
    </div>
  );
}

function OrganizationRoleSelect(props: {
  disabled?: boolean;
  label?: string;
  onChange: (role: OrganizationMemberRole) => void;
  value: OrganizationMemberRole;
}) {
  const { t } = useLingui();
  const roleLabel = (role: string) =>
    role === "ADMIN" ? t`Organization admin` : t`Member`;

  return (
    <Select
      class="grid gap-1.5"
      value={props.value}
      onChange={(role) => role != null && props.onChange(role)}
      options={ORGANIZATION_ROLE_OPTIONS}
      disabled={props.disabled}
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          {roleLabel(props.item.rawValue)}
        </SelectItem>
      )}
    >
      <Show when={props.label}>
        {(label) => <SelectLabel>{label()}</SelectLabel>}
      </Show>
      <SelectTrigger class="w-full sm:w-[140px]">
        <SelectValue<OrganizationMemberRole>>
          {(state) => roleLabel(state.selectedOption())}
        </SelectValue>
      </SelectTrigger>
      <SelectDescription class="sr-only">{t`Role`}</SelectDescription>
      <SelectContent />
    </Select>
  );
}

function OrganizationMemberManagementCard(props: {
  account: AccountPageAccount;
}) {
  const { t } = useLingui();
  const roleLabel = (role: string) =>
    role === "ADMIN" ? t`Organization admin` : t`Member`;
  const environment = useRelayEnvironment();
  const [members, setMembers] = createSignal<
    readonly OrganizationMemberRow[]
  >([]);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal("");
  const [inviteUsername, setInviteUsername] = createSignal("");
  const [selectedInviteAccount, setSelectedInviteAccount] = createSignal<
    LocalAutocompleteAccount | null
  >(null);
  const [inviteRole, setInviteRole] = createSignal<OrganizationMemberRole>(
    "MEMBER",
  );
  const [inviting, setInviting] = createSignal(false);
  const [updatingMemberId, setUpdatingMemberId] = createSignal<string | null>(
    null,
  );
  const [removingMemberId, setRemovingMemberId] = createSignal<string | null>(
    null,
  );
  const [inviteMember] = createMutation<
    accountInviteOrganizationMemberMutation
  >(accountInviteOrganizationMemberMutation);
  const [updateRole] = createMutation<
    accountUpdateOrganizationMemberRoleMutation
  >(accountUpdateOrganizationMemberRoleMutation);
  const [removeMember] = createMutation<
    accountRemoveOrganizationMemberMutation
  >(accountRemoveOrganizationMemberMutation);
  const canInvite = createMemo(() =>
    inviteUsername().trim() !== "" && !inviting()
  );

  async function loadMembers() {
    setLoading(true);
    setLoadError("");
    try {
      const result = await fetchQuery<accountOrganizationMembersQuery>(
        environment(),
        accountOrganizationMembersQuery,
        { username: props.account.username },
      ).toPromise();
      setMembers(result?.accountByUsername?.organizationMembers ?? []);
    } catch (error) {
      console.error(error);
      setLoadError(
        error instanceof Error
          ? error.message
          : t`Members could not be loaded.`,
      );
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    void loadMembers();
  });

  function onInvite(event: SubmitEvent) {
    event.preventDefault();
    if (!canInvite()) return;
    setInviting(true);
    inviteMember({
      variables: {
        organizationId: props.account.id,
        username: inviteUsername().trim(),
        role: inviteRole(),
      },
      onCompleted(response) {
        setInviting(false);
        const result = response.inviteOrganizationMember;
        if (result?.__typename === "InviteOrganizationMemberPayload") {
          setInviteUsername("");
          setSelectedInviteAccount(null);
          showToast({
            title: t`Invitation sent`,
            description:
              t`${result.membership.member.username} can now accept the organization invitation.`,
          });
          return;
        }
        showToast({
          title: t`Could not invite member`,
          description: result != null && "message" in result
            ? result.message
            : t`The member could not be invited. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setInviting(false);
        showToast({
          title: t`Could not invite member`,
          description: t`The member could not be invited. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  function onInviteUsernameInput(value: string) {
    const username = value.trim().replace(/^@/, "");
    setInviteUsername(username);
    setSelectedInviteAccount((account) =>
      account?.username === username ? account : null
    );
  }

  function selectInviteAccount(account: LocalAutocompleteAccount) {
    if (account.kind !== "PERSONAL") return;
    setInviteUsername(account.username);
    setSelectedInviteAccount(account);
  }

  function onUpdateRole(
    member: OrganizationMemberRow,
    role: OrganizationMemberRole,
  ) {
    if (member.role === role || updatingMemberId() != null) return;
    setUpdatingMemberId(member.member.id);
    updateRole({
      variables: {
        organizationId: props.account.id,
        memberId: member.member.id,
        role,
      },
      onCompleted(response) {
        setUpdatingMemberId(null);
        const result = response.updateOrganizationMemberRole;
        if (result?.__typename === "UpdateOrganizationMemberRolePayload") {
          showToast({
            title: t`Role updated`,
            description: t`${result.membership.member.username} is now ${
              roleLabel(result.membership.role)
            }.`,
          });
          void loadMembers();
          return;
        }
        showToast({
          title: t`Could not update role`,
          description: result != null && "message" in result
            ? result.message
            : t`The member role could not be updated. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setUpdatingMemberId(null);
        showToast({
          title: t`Could not update role`,
          description:
            t`The member role could not be updated. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  function onRemove(member: OrganizationMemberRow) {
    if (removingMemberId() != null) return;
    setRemovingMemberId(member.member.id);
    removeMember({
      variables: {
        organizationId: props.account.id,
        memberId: member.member.id,
      },
      onCompleted(response) {
        setRemovingMemberId(null);
        const result = response.removeOrganizationMember;
        if (result?.__typename === "RemoveOrganizationMemberPayload") {
          showToast({
            title: t`Member removed`,
            description:
              t`${result.membership.member.username} no longer belongs to this organization.`,
          });
          void loadMembers();
          return;
        }
        showToast({
          title: t`Could not remove member`,
          description: result != null && "message" in result
            ? result.message
            : t`The member could not be removed. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setRemovingMemberId(null);
        showToast({
          title: t`Could not remove member`,
          description: t`The member could not be removed. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t`Organization members`}</CardTitle>
        <CardDescription>
          {t`Invite members and choose who can manage this organization.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-col gap-6">
          <form class="flex flex-col gap-4" onSubmit={onInvite}>
            <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <ActorHandleAutocomplete
                inputId="organization-member-username"
                label={t`Username`}
                placeholder={t`member`}
                value={inviteUsername()}
                disabled={inviting()}
                localAccountsOnly
                accountKind="PERSONAL"
                suggestionIdentifier="username"
                selectedActor={selectedInviteAccount()}
                description={t`Invite a personal account by its local username.`}
                onInput={onInviteUsernameInput}
                onSelect={(actor) => {
                  const account = actor.account;
                  if (account == null) return;
                  selectInviteAccount(account);
                }}
              />
              <OrganizationRoleSelect
                value={inviteRole()}
                onChange={setInviteRole}
                disabled={inviting()}
                label={t`Role`}
              />
            </div>
            <div>
              <Button type="submit" disabled={!canInvite()}>
                <IconUserPlus />
                {inviting() ? t`Inviting…` : t`Invite member`}
              </Button>
            </div>
          </form>

          <div class="border-t pt-5">
            <Switch>
              <Match when={loading()}>
                <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t`Loading members…`}
                </p>
              </Match>
              <Match when={loadError() !== ""}>
                <p class="rounded-md border border-error-foreground bg-error p-4 text-sm text-error-foreground">
                  {loadError()}
                </p>
              </Match>
              <Match when={members().length < 1}>
                <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t`No members found.`}
                </p>
              </Match>
              <Match when={members().length > 0}>
                <div class="overflow-hidden rounded-md border">
                  <For each={members()}>
                    {(membership) => (
                      <div class="flex flex-col gap-3 border-b p-3 last:border-b-0 lg:flex-row lg:items-center lg:justify-between">
                        <OrganizationIdentity
                          avatarUrl={membership.member.avatarUrl}
                          name={membership.member.name}
                          username={membership.member.username}
                        />
                        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <OrganizationRoleSelect
                            value={membership.role === "ADMIN"
                              ? "ADMIN"
                              : "MEMBER"}
                            onChange={(role) => onUpdateRole(membership, role)}
                            disabled={updatingMemberId() != null ||
                              removingMemberId() != null}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={updatingMemberId() != null ||
                              removingMemberId() != null}
                            onClick={() => onRemove(membership)}
                          >
                            <IconUserMinus />
                            {removingMemberId() === membership.member.id
                              ? t`Removing…`
                              : t`Remove`}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface AccountMigrationAliasesFormProps {
  aliases: readonly string[];
  id: string;
}

function AccountMigrationAliasesForm(
  props: AccountMigrationAliasesFormProps,
) {
  const { t } = useLingui();
  const [actor, setActor] = createSignal("");
  const [error, setError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [removingAlias, setRemovingAlias] = createSignal<string | null>(null);
  const canAdd = createMemo(() => actor().trim() !== "" && !adding());
  const [addAlias] = createMutation<accountAddMigrationAliasMutation>(
    accountAddMigrationAliasMutation,
  );
  const [removeAliasMutation] = createMutation<
    accountRemoveMigrationAliasMutation
  >(accountRemoveMigrationAliasMutation);

  function showMutationError(title: string, description: string) {
    showToast({ title, description, variant: "error" });
  }

  function onAdd(event: SubmitEvent) {
    event.preventDefault();
    if (!canAdd()) return;
    const value = actor().trim();
    setError("");
    setAdding(true);
    addAlias({
      variables: {
        accountId: props.id,
        actor: value,
      },
      onCompleted(response) {
        setAdding(false);
        const result = response.addAccountMigrationAlias;
        if (result?.__typename === "AddAccountMigrationAliasPayload") {
          setActor("");
          showToast({
            title: t`Previous account added`,
            description:
              t`Hackers' Pub now publishes the old account as another account that belongs to you.`,
          });
          return;
        }
        if (result?.__typename === "NotAuthenticatedError") {
          showMutationError(
            t`Sign in required`,
            t`Please sign in again before changing account migration settings.`,
          );
          return;
        }
        if (result?.__typename === "NotAuthorizedError") {
          showMutationError(
            t`Cannot update this account`,
            t`You can prepare migration only for your own account.`,
          );
          return;
        }
        const message =
          t`Enter the account you are moving from, such as @old@example.com or its actor URL.`;
        setError(message);
        showMutationError(t`Could not add previous account`, message);
      },
      onError(error) {
        console.error(error);
        setAdding(false);
        showMutationError(
          t`Could not add previous account`,
          t`The previous account could not be added. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        );
      },
    });
  }

  function onRemove(alias: string) {
    if (removingAlias() != null) return;
    setError("");
    setRemovingAlias(alias);
    removeAliasMutation({
      variables: {
        accountId: props.id,
        alias,
      },
      onCompleted(response) {
        setRemovingAlias(null);
        const result = response.removeAccountMigrationAlias;
        if (result?.__typename === "RemoveAccountMigrationAliasPayload") {
          showToast({
            title: t`Previous account removed`,
            description:
              t`Hackers' Pub no longer publishes that account as another account that belongs to you.`,
          });
          return;
        }
        if (result?.__typename === "NotAuthenticatedError") {
          showMutationError(
            t`Sign in required`,
            t`Please sign in again before changing account migration settings.`,
          );
          return;
        }
        if (result?.__typename === "NotAuthorizedError") {
          showMutationError(
            t`Cannot update this account`,
            t`You can prepare migration only for your own account.`,
          );
          return;
        }
        showMutationError(
          t`Could not remove previous account`,
          t`The previous account could not be removed. Please try again.`,
        );
      },
      onError(error) {
        console.error(error);
        setRemovingAlias(null);
        showMutationError(
          t`Could not remove previous account`,
          t`The previous account could not be removed. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        );
      },
    });
  }

  return (
    <div class="flex flex-col gap-5">
      <div class="space-y-3 text-sm text-muted-foreground">
        <p>
          {t`This page only prepares the Hackers' Pub side of the move. The move still starts from your old server.`}
        </p>
        <ol class="ml-4 list-decimal space-y-2">
          <li>
            {t`Add the old account here. Hackers' Pub will publish it as another account that belongs to you.`}
          </li>
          <li>
            {t`On the old server, open account migration settings and set this Hackers' Pub account as the new account.`}
          </li>
          <li>
            {t`After the old server confirms the destination, it sends the Move activity and compatible servers can move followers here.`}
          </li>
        </ol>
      </div>

      <form class="flex flex-col gap-4" onSubmit={onAdd}>
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <TextField
            value={actor()}
            onChange={(value) => {
              setActor(value);
              if (error() !== "") setError("");
            }}
            validationState={error() === "" ? "valid" : "invalid"}
          >
            <TextFieldLabel>{t`Old account`}</TextFieldLabel>
            <TextFieldInput
              type="text"
              autocomplete="off"
              autocapitalize="none"
              inputmode="email"
              placeholder={t`@old@example.com or actor URL`}
              disabled={adding()}
            />
            <Show
              when={error() !== ""}
              fallback={
                <TextFieldDescription>
                  {t`Enter the account you are moving from, for example @old@example.com.`}
                </TextFieldDescription>
              }
            >
              <TextFieldErrorMessage>{error()}</TextFieldErrorMessage>
            </Show>
          </TextField>
          <Button
            type="submit"
            class="w-full sm:mt-6 sm:w-auto"
            disabled={!canAdd()}
          >
            <IconPlus />
            {adding() ? t`Adding…` : t`Add`}
          </Button>
        </div>
      </form>

      <Show
        when={props.aliases.length > 0}
        fallback={
          <p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t`No previous accounts added yet.`}
          </p>
        }
      >
        <div class="overflow-hidden rounded-md border">
          <For each={props.aliases}>
            {(alias) => (
              <div class="flex flex-col gap-3 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                <code class="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {alias}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="w-full shrink-0 sm:w-auto"
                  disabled={removingAlias() != null}
                  aria-label={t`Remove ${alias}`}
                  onClick={() => onRemove(alias)}
                >
                  <IconTrash2 />
                  {removingAlias() === alias ? t`Removing…` : t`Remove`}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface AccountDeletionFormProps {
  id: string;
  kind?: "personal" | "organization";
  username: string;
}

function AccountDeletionForm(props: AccountDeletionFormProps) {
  const { t } = useLingui();
  const [confirmation, setConfirmation] = createSignal("");
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const isOrganization = () => props.kind === "organization";
  const canDelete = createMemo(() =>
    confirmation().trim().toLowerCase() === props.username.toLowerCase() &&
    !deleting()
  );
  const [deleteAccount] = createMutation<accountDeleteMutation>(
    accountDeleteMutation,
  );

  function onDelete() {
    if (!canDelete()) return;
    setDeleting(true);
    deleteAccount({
      variables: { id: props.id },
      onCompleted(response) {
        const result = response.deleteAccount;
        if (result == null) {
          setDeleting(false);
          setConfirmOpen(false);
          showToast({
            title: t`Failed to delete account`,
            description:
              t`The deletion request could not be completed. Please try again.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "DeleteAccountPayload") {
          if (isOrganization()) {
            showToast({
              title: t`Organization deleted`,
              description: t`The organization account was deleted.`,
            });
            location.replace("/local");
            return;
          }
          void removeSessionCookie().finally(() => location.replace("/local"));
          return;
        }
        setDeleting(false);
        setConfirmOpen(false);
        if (result.__typename === "AccountDeletionUnavailableError") {
          showToast({
            title: isOrganization()
              ? t`Organization deletion is unavailable`
              : t`Account deletion is unavailable`,
            description: isOrganization()
              ? t`This organization cannot be deleted right now. Please contact the instance administrators.`
              : t`This account cannot be deleted right now. Please contact the instance administrators.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "NotAuthenticatedError") {
          showToast({
            title: t`Sign in required`,
            description: t`Please sign in again before deleting your account.`,
            variant: "error",
          });
          return;
        }
        if (result.__typename === "NotAuthorizedError") {
          showToast({
            title: isOrganization()
              ? t`Cannot delete this organization`
              : t`Cannot delete this account`,
            description: isOrganization()
              ? t`Only organization admins can delete this organization.`
              : t`You can delete only your own account.`,
            variant: "error",
          });
          return;
        }
        showToast({
          title: t`Failed to delete account`,
          description:
            t`The deletion request could not be completed. Please try again.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setDeleting(false);
        setConfirmOpen(false);
        showToast({
          title: t`Failed to delete account`,
          description:
            t`The deletion request could not be completed. Please try again.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <div class="flex flex-col gap-5">
      <div class="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm">
        <p class="font-medium text-destructive">
          {t`This action is permanent.`}
        </p>
        <p class="mt-2 text-muted-foreground">
          {isOrganization()
            ? t`This organization's profile, posts, drafts, follows, settings, and memberships will be removed. Its username will remain reserved.`
            : t`Your profile, posts, drafts, follows, settings, and login credentials will be removed. Your current username will remain reserved.`}
        </p>
      </div>

      <TextField
        value={confirmation()}
        onChange={setConfirmation}
      >
        <TextFieldLabel>{t`Username`}</TextFieldLabel>
        <TextFieldInput
          autocomplete="off"
          autocapitalize="none"
          inputmode="text"
          placeholder={props.username}
        />
        <TextFieldDescription>
          {isOrganization()
            ? t`Type ${props.username} to confirm organization deletion.`
            : t`Type ${props.username} to confirm account deletion.`}
        </TextFieldDescription>
      </TextField>

      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={!canDelete()}
          onClick={() => setConfirmOpen(true)}
        >
          <IconTrash2 />
          {isOrganization() ? t`Delete organization` : t`Delete account`}
        </Button>
      </div>

      <AlertDialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isOrganization()
                ? t`Delete organization permanently?`
                : t`Delete account permanently?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isOrganization()
                ? t`This cannot be undone. The organization account will be deleted, but you will stay signed in.`
                : t`This cannot be undone. Your account will be deleted and you will be signed out.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={deleting()}>
              {t`Cancel`}
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!canDelete()}
              onClick={onDelete}
            >
              <IconTrash2 />
              {deleting()
                ? t`Deleting…`
                : isOrganization()
                ? t`Delete organization`
                : t`Delete account`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

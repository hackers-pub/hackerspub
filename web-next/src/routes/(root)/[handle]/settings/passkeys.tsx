import {
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  Navigate,
  query,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
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
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { passkeysGetPasskeyRegistrationOptionsMutation } from "./__generated__/passkeysGetPasskeyRegistrationOptionsMutation.graphql.ts";
import type { passkeysPageQuery } from "./__generated__/passkeysPageQuery.graphql.ts";
import type { passkeysRevokePasskeyMutation } from "./__generated__/passkeysRevokePasskeyMutation.graphql.ts";
import type { passkeysVerifyPasskeyRegistrationMutation } from "./__generated__/passkeysVerifyPasskeyRegistrationMutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadPageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const passkeysPageQuery = graphql`
  query passkeysPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      passkeys(first: 50) {
        edges {
          node {
            id
            name
            lastUsed
            created
          }
        }
      }
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
  }
`;

const loadPageQuery = query(
  (handle: string) =>
    loadQuery<passkeysPageQuery>(
      useRelayEnvironment()(),
      passkeysPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadpasskeysPageQuery",
);

const getPasskeyRegistrationOptionsMutation = graphql`
  mutation passkeysGetPasskeyRegistrationOptionsMutation($accountId: ID!) {
    getPasskeyRegistrationOptions(accountId: $accountId)
  }
`;

const verifyPasskeyRegistrationMutation = graphql`
  mutation passkeysVerifyPasskeyRegistrationMutation(
    $accountId: ID!
    $name: String!
    $registrationResponse: JSON!
  ) {
    verifyPasskeyRegistration(
      accountId: $accountId
      name: $name
      registrationResponse: $registrationResponse
    )
  }
`;

const revokePasskeyMutation = graphql`
  mutation passkeysRevokePasskeyMutation($passkeyId: ID!) {
    revokePasskey(passkeyId: $passkeyId)
  }
`;

export default function passkeysPage() {
  const params = useParams();
  const location = useLocation();
  const { t } = useLingui();

  const data = createPreloadedQuery<passkeysPageQuery>(
    passkeysPageQuery,
    () => loadPageQuery(params.handle),
  );

  const refreshData = () => {
    // TODO: Fix Relay query refreshing - currently loadQuery doesn't update the UI
    // The loadQuery call fetches data but doesn't update the createPreloadedQuery
    // Need to investigate proper solid-relay patterns for refreshing queries
    window.location.reload();
  };

  const [getOptions] = createMutation<
    passkeysGetPasskeyRegistrationOptionsMutation
  >(
    getPasskeyRegistrationOptionsMutation,
  );
  const [verifyRegistration] = createMutation<
    passkeysVerifyPasskeyRegistrationMutation
  >(
    verifyPasskeyRegistrationMutation,
  );
  const [revokePasskey] = createMutation<passkeysRevokePasskeyMutation>(
    revokePasskeyMutation,
  );

  const [registering, setRegistering] = createSignal(false);
  const [passkeyName, setPasskeyName] = createSignal("");
  const [passkeyToRevoke, setPasskeyToRevoke] = createSignal<
    { id: string; name: string } | null
  >(null);

  async function onRegisterPasskey() {
    const account = data()?.accountByUsername;
    const name = passkeyName().trim();
    if (!account || !name) return;

    setRegistering(true);

    try {
      // Get registration options
      const optionsResponse = await new Promise<
        passkeysGetPasskeyRegistrationOptionsMutation["response"]
      >((resolve, reject) => {
        getOptions({
          variables: { accountId: account.id },
          onCompleted: resolve,
          onError: reject,
        });
      });

      const options = optionsResponse.getPasskeyRegistrationOptions;
      if (!options || typeof options !== "object") {
        throw new Error("Invalid registration options");
      }

      // Use @simplewebauthn/browser to handle registration
      let registrationResponse: RegistrationResponseJSON;
      try {
        registrationResponse = await startRegistration({
          optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
        });
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : "Registration failed",
        );
      }

      // Verify registration
      const verifyResponse = await new Promise<
        passkeysVerifyPasskeyRegistrationMutation["response"]
      >((resolve, reject) => {
        verifyRegistration({
          variables: {
            accountId: account.id,
            name,
            registrationResponse,
          },
          onCompleted: resolve,
          onError: reject,
        });
      });

      const result = verifyResponse.verifyPasskeyRegistration;
      if (
        result && typeof result === "object" && "verified" in result &&
        result.verified
      ) {
        showToast({
          title: t`Passkey registered successfully`,
          description:
            t`Your passkey has been registered and can now be used for authentication.`,
          variant: "success",
        });
        setPasskeyName("");
        // Refresh the data to show the new passkey
        refreshData();
      } else {
        throw new Error("Passkey verification failed");
      }
    } catch (error) {
      showToast({
        title: t`Failed to register passkey`,
        description: error instanceof Error
          ? error.message
          : t`An error occurred while registering your passkey.`,
        variant: "error",
      });
    } finally {
      setRegistering(false);
    }
  }

  function openRevokeDialog(passkeyId: string, passkeyName: string) {
    setPasskeyToRevoke({ id: passkeyId, name: passkeyName });
  }

  async function confirmRevokePasskey() {
    const passkey = passkeyToRevoke();
    if (!passkey) return;

    try {
      const response = await new Promise<
        passkeysRevokePasskeyMutation["response"]
      >((resolve, reject) => {
        revokePasskey({
          variables: { passkeyId: passkey.id },
          onCompleted: resolve,
          onError: reject,
        });
      });

      if (response.revokePasskey) {
        showToast({
          title: t`Passkey revoked`,
          description: t`The passkey has been successfully revoked.`,
          variant: "success",
        });
        // Refresh the data to remove the revoked passkey
        refreshData();
      } else {
        showToast({
          title: t`Failed to revoke passkey`,
          variant: "error",
        });
      }
    } catch (error) {
      showToast({
        title: t`Failed to revoke passkey`,
        description: error instanceof Error
          ? error.message
          : t`An error occurred while revoking your passkey.`,
        variant: "error",
      });
    } finally {
      setPasskeyToRevoke(null);
    }
  }

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().viewer}
            fallback={
              <Navigate
                href={`/sign?next=${encodeURIComponent(location.pathname)}`}
              />
            }
          >
            {(viewer) => (
              <Show when={data().accountByUsername}>
                {(account) => (
                  <Show when={viewer().id !== account().id}>
                    <Navigate href="/" />
                  </Show>
                )}
              </Show>
            )}
          </Show>
          <Show when={data().accountByUsername}>
            {(account) => (
              <>
                <Title>{t`passkeys`}</Title>
                <ProfilePageBreadcrumb $actor={account().actor}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink href={`/@${account().username}/settings`}>
                      {t`Settings`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`passkeys`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs selected="passkeys" $account={account()} />

                    <div class="mt-6 space-y-6">
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Register a passkey`}</CardTitle>
                          <CardDescription>
                            {t`Register a passkey to sign in to your account. You can use a passkey instead of receiving a sign-in link by email.`}
                          </CardDescription>
                        </CardHeader>
                        <CardContent class="space-y-4">
                          <TextField class="grid w-full items-center gap-1.5">
                            <TextFieldLabel for="passkey-name">
                              {t`Passkey name`}
                            </TextFieldLabel>
                            <TextFieldInput
                              type="text"
                              id="passkey-name"
                              placeholder={t`ex) My key`}
                              required
                              value={passkeyName()}
                              onInput={(e) =>
                                setPasskeyName(e.currentTarget.value)}
                            />
                          </TextField>
                          <Button
                            type="button"
                            onClick={onRegisterPasskey}
                            disabled={registering() ||
                              passkeyName().trim() === ""}
                            class="w-full cursor-pointer"
                          >
                            {registering() ? t`Registering...` : t`Register`}
                          </Button>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Registered passkeys`}</CardTitle>
                          <CardDescription>
                            {t`The following passkeys are registered to your account. You can use them to sign in to your account.`}
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <Show
                            when={account().passkeys.edges.length > 0}
                            fallback={
                              <p class="text-muted-foreground text-center py-8">
                                {t`You don't have any passkeys registered yet.`}
                              </p>
                            }
                          >
                            <div class="space-y-4">
                              <For each={account().passkeys.edges}>
                                {(edge) => (
                                  <div class="flex items-center justify-between p-4 border rounded-lg">
                                    <div class="space-y-1">
                                      <h4 class="font-medium">
                                        {edge.node.name}
                                      </h4>
                                      <div class="text-sm text-muted-foreground space-y-1">
                                        <div>
                                          {t`Created:`}{" "}
                                          <Timestamp
                                            value={edge.node.created}
                                          />
                                        </div>
                                        <div>
                                          {edge.node.lastUsed
                                            ? (
                                              <>
                                                {t`Last used:`}{" "}
                                                <Timestamp
                                                  value={edge.node.lastUsed}
                                                />
                                              </>
                                            )
                                            : t`Never used`}
                                        </div>
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      variant="destructive"
                                      size="sm"
                                      class="cursor-pointer hover:bg-destructive/70"
                                      onClick={() =>
                                        openRevokeDialog(
                                          edge.node.id,
                                          edge.node.name,
                                        )}
                                    >
                                      {t`Revoke`}
                                    </Button>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </div>
              </>
            )}
          </Show>
          <AlertDialog
            open={passkeyToRevoke() != null}
            onOpenChange={() => setPasskeyToRevoke(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t`Revoke passkey`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`Are you sure you want to revoke passkey ${passkeyToRevoke()?.name}? You won't be able to use it to sign in to your account anymore.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose>{t`Cancel`}</AlertDialogClose>
                <AlertDialogAction
                  class="bg-destructive text-destructive-foreground hover:bg-destructive/70"
                  onClick={confirmRevokePasskey}
                >
                  {t`Revoke`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </Show>
  );
}

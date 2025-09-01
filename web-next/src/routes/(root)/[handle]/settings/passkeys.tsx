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
  createPaginationFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
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
import { passkeysFragment_account$key } from "./__generated__/passkeysFragment_account.graphql.ts";
import type { passkeysGetPasskeyRegistrationOptionsMutation } from "./__generated__/passkeysGetPasskeyRegistrationOptionsMutation.graphql.ts";
import type { passkeysPageQuery } from "./__generated__/passkeysPageQuery.graphql.ts";
import type { passkeysRevokePasskeyMutation } from "./__generated__/passkeysRevokePasskeyMutation.graphql.ts";
import type { passkeysVerifyPasskeyRegistrationMutation } from "./__generated__/passkeysVerifyPasskeyRegistrationMutation.graphql.ts";

const PASSKEYS_PAGE_SIZE = 10 as const;

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadPageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const passkeysPageQuery = graphql`
  query passkeysPageQuery($username: String!, $first: Int, $after: String) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      ...passkeysFragment_account @arguments(first: $first, after: $after)
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
  }
`;

const passkeysFragment = graphql`
  fragment passkeysFragment_account on Account 
  @refetchable(queryName: "PasskeysPaginationQuery")
  @argumentDefinitions(
    first: { type: "Int" }, 
    after: { type: "String" }
  ) {
    passkeys(first: $first, after: $after) 
    @connection(key: "passkeysFragment_passkeys") {
      __id
      edges {
        node {
          id
          name
          lastUsed
          created
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

const loadPageQuery = query(
  (
    handle: string,
    first: number = PASSKEYS_PAGE_SIZE,
    after: string | null = null,
  ) =>
    loadQuery<passkeysPageQuery>(
      useRelayEnvironment()(),
      passkeysPageQuery,
      {
        username: handle.replace(/^@/, ""),
        first,
        after,
      },
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
    $connections: [ID!]!
  ) {
    verifyPasskeyRegistration(
      accountId: $accountId
      name: $name
      registrationResponse: $registrationResponse
    ) {
      verified
      passkey @appendNode(connections: $connections, edgeTypeName: "Passkey") {
        id
        name
        lastUsed
        created
      }
    }
  }
`;

const revokePasskeyMutation = graphql`
  mutation passkeysRevokePasskeyMutation($passkeyId: ID!, $connections: [ID!]!) {
    revokePasskey(passkeyId: $passkeyId) @deleteEdge(connections: $connections)
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
  let passkeyNameRef: HTMLInputElement | undefined;
  const [passkeyToRevoke, setPasskeyToRevoke] = createSignal<
    { id: string; name: string } | null
  >(null);
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  // Use pagination fragment for passkey data
  const passkeyData = createPaginationFragment(
    passkeysFragment,
    () => data()?.accountByUsername as passkeysFragment_account$key,
  );

  const loadMorePasskeys = () => {
    setLoadingState("loading");
    passkeyData.loadNext(PASSKEYS_PAGE_SIZE, {
      onComplete: (error) => {
        if (error) {
          setLoadingState("errored");
        } else {
          setLoadingState("loaded");
        }
      },
    });
  };

  async function onRegisterPasskey() {
    const account = data()?.accountByUsername;
    const name = passkeyNameRef?.value?.trim() ?? "";
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
            connections: [passkeyData()!.passkeys.__id],
          },
          onCompleted: resolve,
          onError: reject,
        });
      });

      const result = verifyResponse.verifyPasskeyRegistration;
      if (result && result.verified) {
        showToast({
          title: t`Passkey registered successfully`,
          description:
            t`Your passkey has been registered and can now be used for authentication.`,
          variant: "success",
        });
        if (passkeyNameRef) passkeyNameRef.value = "";
        // No need to manually refresh - @appendNode automatically updates the connection
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
          variables: {
            passkeyId: passkey.id,
            connections: [passkeyData()!.passkeys.__id],
          },
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
        // No need to manually refresh - @deleteEdge automatically updates the connection
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
                <Title>{t`Passkeys`}</Title>
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
                      {t`Passkeys`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs selected="passkeys" $account={account()} />

                    <div class="mt-4 space-y-6">
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
                              placeholder={t`My passkey`}
                              required
                              ref={passkeyNameRef}
                            />
                          </TextField>
                          <Button
                            type="button"
                            onClick={onRegisterPasskey}
                            disabled={registering()}
                            class="w-full cursor-pointer"
                          >
                            {registering() ? t`Registering…` : t`Register`}
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
                            when={(passkeyData()?.passkeys.edges.length ?? 0) >
                              0}
                            fallback={
                              <p class="text-muted-foreground text-center py-8">
                                {t`You don't have any passkeys registered yet.`}
                              </p>
                            }
                          >
                            <div class="space-y-4">
                              <For
                                each={(() => {
                                  const paginatedData = passkeyData();
                                  return paginatedData
                                    ? paginatedData.passkeys.edges
                                    : [];
                                })()}
                              >
                                {(edge) => (
                                  <div class="flex items-center justify-between p-4 border rounded-lg">
                                    <div class="space-y-1">
                                      <h4 class="font-medium">
                                        {edge.node.name}
                                      </h4>
                                      <div class="text-sm text-muted-foreground space-y-1">
                                        <div>
                                          <Trans
                                            message={t`Created ${"RELATIVE_DATE"}`}
                                            values={{
                                              RELATIVE_DATE: () => (
                                                <Timestamp
                                                  value={edge.node.created}
                                                />
                                              ),
                                            }}
                                          />
                                        </div>
                                        <div>
                                          <Show
                                            when={edge.node.lastUsed}
                                            fallback={t`Never used`}
                                          >
                                            {(lastUsed) => (
                                              <Trans
                                                message={t`Last used ${"RELATIVE_DATE"}`}
                                                values={{
                                                  RELATIVE_DATE: () => (
                                                    <Timestamp
                                                      value={lastUsed()}
                                                    />
                                                  ),
                                                }}
                                              />
                                            )}
                                          </Show>
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

                              <Show
                                when={passkeyData()?.passkeys.pageInfo
                                  .hasNextPage}
                              >
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={loadingState() === "loading"}
                                  onClick={loadMorePasskeys}
                                  class="w-full cursor-pointer"
                                >
                                  {loadingState() === "loading"
                                    ? t`Loading more passkeys…`
                                    : loadingState() === "errored"
                                    ? t`Failed to load more passkeys; click to retry`
                                    : t`Load more passkeys`}
                                </Button>
                              </Show>
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

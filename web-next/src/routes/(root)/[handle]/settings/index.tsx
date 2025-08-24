import {
  Navigate,
  query,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import {
  ProfilePageBreadcrumb,
  ProfilePageBreadcrumbItem,
  ProfilePageBreadcrumbProvider,
} from "~/components/ProfilePageBreadcrumb.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { SettingsTabs } from "../../../../components/SettingsTabs.tsx";
import type { settingsMutation } from "./__generated__/settingsMutation.graphql.ts";
import type { settingsPageQuery } from "./__generated__/settingsPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    void loadPageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const settingsPageQuery = graphql`
  query settingsPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      usernameChanged
      name
      bio
      ...SettingsTabs_account
      actor {
        ...ProfilePageBreadcrumb_actor
      }
    }
  }
`;

const loadPageQuery = query(
  (handle: string) =>
    loadQuery<settingsPageQuery>(
      useRelayEnvironment()(),
      settingsPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadSettingsPageQuery",
);

const settingsMutation = graphql`
  mutation settingsMutation($id: ID!, $username: String, $name: String!, $bio: String!) {
    updateAccount(input: {
      id: $id,
      username: $username,
      name: $name,
      bio: $bio,
    }) {
      account {
        id
        username
        usernameChanged
        name
        bio
        ...SettingsTabs_account
      }
    }
  }
`;

export default function SettingsPage() {
  const params = useParams();
  const location = useLocation();
  const { t } = useLingui();
  let usernameInput: HTMLInputElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let bioInput: HTMLTextAreaElement | undefined;
  const data = createPreloadedQuery<settingsPageQuery>(
    settingsPageQuery,
    () => loadPageQuery(params.handle),
  );
  const [save] = createMutation<settingsMutation>(settingsMutation);
  const [saving, setSaving] = createSignal(false);
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const account = data()?.accountByUsername;
    const id = account?.id;
    const usernameChanged = account?.usernameChanged;
    if (
      usernameInput == null || nameInput == null || bioInput == null ||
      id == null
    ) return;
    setSaving(true);
    const username = usernameInput.value;
    const name = nameInput.value;
    const bio = bioInput.value;
    save({
      variables: {
        id,
        username: usernameChanged == null ? username : undefined,
        name,
        bio,
      },
      onCompleted() {
        setSaving(false);
        showToast({
          title: t`Successfully saved settings`,
          description: t`Your profile settings have been updated successfully.`,
        });
      },
      onError(error) {
        console.error(error);
        showToast({
          title: t`Failed to save settings`,
          description:
            t`An error occurred while saving your settings. Please try again, or contact support if the problem persists.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
        setSaving(false);
      },
    });
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
                <Title>{t`Profile settings`}</Title>
                <ProfilePageBreadcrumbProvider>
                  <ProfilePageBreadcrumb $actor={account().actor} />
                  <ProfilePageBreadcrumbItem breadcrumb={t`Settings`} />
                </ProfilePageBreadcrumbProvider>
                <form on:submit={onSubmit}>
                  <div class="p-4">
                    <div class="mx-auto max-w-prose">
                      <SettingsTabs
                        selected="profile"
                        $account={account()}
                      />
                      <div class="flex flex-col gap-4 mt-4">
                        <TextField class="grid w-full items-center gap-1.5">
                          <TextFieldLabel for="username">
                            {t`Username`}
                          </TextFieldLabel>
                          <TextFieldInput
                            ref={usernameInput}
                            type="text"
                            pattern="^[a-z0-9_]{1,15}$"
                            required
                            id="username"
                            placeholder="username"
                            value={account().username}
                            disabled={account().usernameChanged != null}
                          />
                          <TextFieldDescription class="leading-6">
                            {t`Your username will be used to create your profile URL and your fediverse handle.`}
                            {" "}
                            <strong>
                              {t`You can change it only once, and the old username will become available to others.`}
                              <Show when={account().usernameChanged}>
                                {(changed) => (
                                  <>
                                    {" "}
                                    <Trans
                                      message={t`As you have already changed it ${"CHANGED"}, you can't change it again.`}
                                      values={{
                                        CHANGED: () => (
                                          <Timestamp value={changed()} />
                                        ),
                                      }}
                                    />
                                  </>
                                )}
                              </Show>
                            </strong>
                          </TextFieldDescription>
                        </TextField>
                        <TextField class="grid w-full items-center gap-1.5">
                          <TextFieldLabel for="name">
                            {t`Display name`}
                          </TextFieldLabel>
                          <TextFieldInput
                            ref={nameInput}
                            type="text"
                            id="name"
                            required
                            placeholder={t`John Doe`}
                            value={account().name}
                          />
                          <TextFieldDescription class="leading-6">
                            {t`Your name will be displayed on your profile and in your posts.`}
                          </TextFieldDescription>
                        </TextField>
                        <TextField class="grid w-full items-center gap-1.5">
                          <TextFieldLabel for="bio">
                            {t`Bio`}
                          </TextFieldLabel>
                          <TextFieldTextArea
                            ref={bioInput}
                            id="bio"
                            value={account().bio}
                            rows={7}
                          />
                          <TextFieldDescription class="leading-6">
                            {t`Your bio will be displayed on your profile. You can use Markdown to format it.`}
                          </TextFieldDescription>
                        </TextField>
                        <Button
                          type="submit"
                          class="cursor-pointer"
                          disabled={saving()}
                        >
                          {saving() ? t`Saving…` : t`Save`}
                        </Button>
                      </div>
                    </div>
                  </div>
                </form>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

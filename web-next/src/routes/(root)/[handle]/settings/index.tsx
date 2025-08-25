import {
  Navigate,
  query,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { createDropzone } from "@soorria/solid-dropzone";
import type {
  CropperCanvas,
  CropperImage,
  CropperOptions,
  CropperSelection,
} from "cropperjs";
// @ts-ignore: ...
import Cropper from "cropperjs";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.tsx";
import { Label } from "~/components/ui/label.tsx";
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
      avatarUrl
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
  mutation settingsMutation($id: ID!, $username: String, $name: String!, $bio: String!, $avatarUrl: URL) {
    updateAccount(input: {
      id: $id,
      username: $username,
      name: $name,
      bio: $bio,
      avatarUrl: $avatarUrl,
    }) {
      account {
        id
        username
        usernameChanged
        name
        bio
        avatarUrl
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
  let cropperContainer: HTMLDivElement | undefined;
  const [avatarUrl, setAvatarUrl] = createSignal<string | undefined>();
  const [croperOpen, setCropperOpen] = createSignal(false);
  const [cropperSelection, setCropperSelection] = createSignal<
    CropperSelection | undefined
  >();
  const dropzone = createDropzone({
    accept: "image/*",
    maxFiles: 1,
    maxSize: 5 * 1024 * 1024, // 5 MiB
    onDrop(acceptedFiles, fileRejections) {
      if (fileRejections.length > 0) {
        showToast({
          title: t`Please choose an image file smaller than 5 MiB.`,
          variant: "error",
        });
        return;
      }
      const [file] = acceptedFiles;
      const url = URL.createObjectURL(file);
      setCropperOpen(true);
      const cropperImage = new Image();
      cropperImage.src = url;
      const cropper = new Cropper(cropperImage, {
        container: cropperContainer,
        template: `
<cropper-canvas background style="width: 460px; height: 460px;">
  <cropper-image rotatable scalable skewable translatable initial-center-size="cover"></cropper-image>
  <cropper-shade hidden></cropper-shade>
  <cropper-handle action="select" plain></cropper-handle>
  <cropper-selection initial-coverage="0.5" movable resizable aspect-ratio="1">
    <cropper-grid role="grid" covered></cropper-grid>
    <cropper-crosshair centered></cropper-crosshair>
    <cropper-handle action="move" theme-color="rgba(255, 255, 255, 0.35)"></cropper-handle>
    <cropper-handle action="n-resize"></cropper-handle>
    <cropper-handle action="e-resize"></cropper-handle>
    <cropper-handle action="s-resize"></cropper-handle>
    <cropper-handle action="w-resize"></cropper-handle>
    <cropper-handle action="ne-resize"></cropper-handle>
    <cropper-handle action="nw-resize"></cropper-handle>
    <cropper-handle action="se-resize"></cropper-handle>
    <cropper-handle action="sw-resize"></cropper-handle>
  </cropper-selection>
</cropper-canvas>
        `,
      });
      setCropperSelection(cropper.getCropperSelection() ?? undefined);
    },
  });
  function onCrop() {
    const selection = cropperSelection();
    if (selection == null) return;
    selection.$toCanvas().then((canvas) => {
      setAvatarUrl(canvas.toDataURL());
      setCropperOpen(false);
      setCropperSelection(undefined);
    });
  }
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
        avatarUrl: avatarUrl(),
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
                <ProfilePageBreadcrumb $actor={account().actor}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Settings`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <form on:submit={onSubmit}>
                  <div class="p-4">
                    <div class="mx-auto max-w-prose">
                      <SettingsTabs
                        selected="profile"
                        $account={account()}
                      />
                      <div class="flex flex-col gap-4 mt-4">
                        <div class="flex flex-row gap-4">
                          <div class="grow">
                            <Label>{t`Avatar`}</Label>
                            <p class="text-sm text-muted-foreground">
                              {t`Your avatar will be displayed on your profile and in your posts. You can upload a PNG, JPEG, GIF, or WebP image up to 5 MiB in size.`}
                            </p>
                          </div>
                          <div {...dropzone.getRootProps()}>
                            <input {...dropzone.getInputProps()} />
                            <Avatar
                              class="size-16 border-2 hover:border-accent-foreground cursor-pointer"
                              classList={{
                                "border-transparent": !dropzone.isDragActive,
                                "border-accent-foreground":
                                  dropzone.isDragActive,
                              }}
                            >
                              <AvatarImage
                                src={avatarUrl() ?? account().avatarUrl}
                                class="size=16"
                              />
                            </Avatar>
                          </div>
                          <Dialog
                            open={croperOpen()}
                            onOpenChange={setCropperOpen}
                          >
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>
                                  {t`Crop your new avatar`}
                                </DialogTitle>
                                <DialogDescription>
                                  {t`Drag to select the area you want to keep, then click “Crop” to update your avatar.`}
                                </DialogDescription>
                              </DialogHeader>
                              <div
                                ref={cropperContainer}
                                class="w-[460px] h-[460px]"
                              />
                              <DialogFooter class="flex flex-row">
                                <div class="grow">
                                  <Button
                                    class="cursor-pointer"
                                    variant="outline"
                                    onClick={() => {
                                      setCropperOpen(false);
                                      setAvatarUrl(undefined);
                                    }}
                                  >
                                    {t`Cancel`}
                                  </Button>
                                </div>
                                <Button
                                  class="cursor-pointer"
                                  on:click={onCrop}
                                >
                                  {t`Crop`}
                                </Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        </div>
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

declare class Cropper {
  static version: string;
  element: HTMLImageElement | HTMLCanvasElement;
  options: CropperOptions;
  container: Element;
  constructor(
    element: HTMLImageElement | HTMLCanvasElement | string,
    options?: CropperOptions,
  );
  getCropperCanvas(): CropperCanvas | null;
  getCropperImage(): CropperImage | null;
  getCropperSelection(): CropperSelection | null;
  getCropperSelections(): NodeListOf<CropperSelection> | null;
}

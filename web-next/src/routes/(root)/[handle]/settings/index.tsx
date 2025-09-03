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
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import {
  createFragment,
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
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
import { settingsForm_account$key } from "./__generated__/settingsForm_account.graphql.ts";
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
      ...settingsForm_account
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
  mutation settingsMutation($id: ID!, $username: String, $name: String!, $bio: String!, $avatarUrl: URL, $links: [AccountLinkInput!]!) {
    updateAccount(input: {
      id: $id,
      username: $username,
      name: $name,
      bio: $bio,
      avatarUrl: $avatarUrl,
      links: $links,
    }) {
      account {
        ...settingsForm_account
        ...SettingsTabs_account
      }
    }
  }
`;

export default function SettingsPage() {
  const params = useParams();
  const location = useLocation();
  const { t } = useLingui();
  const data = createPreloadedQuery<settingsPageQuery>(
    settingsPageQuery,
    () => loadPageQuery(params.handle),
  );
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
                <div class="p-4">
                  <div class="mx-auto max-w-prose">
                    <SettingsTabs selected="profile" $account={account()} />
                    <Card class="mt-4">
                      <CardHeader>
                        <CardTitle>{t`Profile settings`}</CardTitle>
                        <CardDescription>
                          {t`Update your profile information, including your avatar, username, display name, bio, and links.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <SettingsForm $account={account()} />
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

interface SettingsFormProps {
  $account: settingsForm_account$key;
}

function SettingsForm(props: SettingsFormProps) {
  const { t } = useLingui();
  const account = createFragment(
    graphql`
      fragment settingsForm_account on Account {
        id
        username
        usernameChanged
        name
        bio
        avatarUrl
        links {
          id
          index
          name
          url
        }
      }
    `,
    () => props.$account,
  );
  let usernameInput: HTMLInputElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let bioInput: HTMLTextAreaElement | undefined;
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
  const [links, setLinks] = createStore<{
    readonly links: {
      readonly name: string;
      readonly url: string;
      readonly index: number;
    }[];
  }>({
    links: [...account()?.links ?? [], {
      name: "",
      url: "",
      index: account()?.links.length ?? 0,
    }],
  });
  function onLinkItemChange(
    values: { name: string; url: string; index: number },
  ) {
    setLinks("links", values.index, () => {
      return values;
    });
    if (
      links.links.length < 1 || links.links.at(-1)?.name.trim() !== "" ||
      links.links.at(-1)?.url.trim() !== ""
    ) {
      setLinks("links", links.links.length, {
        name: "",
        url: "",
        index: links.links.length,
      });
    } else if (
      links.links.length > 1 && links.links.at(-2)?.name.trim() === "" &&
      links.links.at(-2)?.url.trim() === ""
    ) {
      setLinks((links) => ({
        links: links.links.slice(0, -1),
      }));
    }
  }
  const [save] = createMutation<settingsMutation>(settingsMutation);
  const [saving, setSaving] = createSignal(false);
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const id = account()?.id;
    const usernameChanged = account()?.usernameChanged;
    if (
      usernameInput == null || nameInput == null || bioInput == null ||
      id == null
    ) return;
    setSaving(true);
    const username = usernameInput.value;
    const name = nameInput.value;
    const bio = bioInput.value;
    setLinks((links) => {
      const newLinks = links.links.filter((l) =>
        l.name.trim() !== "" && l.url.trim() !== ""
      );
      return ({
        links: [
          ...newLinks,
          { name: "", url: "", index: newLinks.length },
        ],
      });
    });
    save({
      variables: {
        id,
        username: usernameChanged == null ? username : undefined,
        name,
        bio,
        avatarUrl: avatarUrl(),
        links: links.links.filter((l) =>
          l.name.trim() !== "" && l.url.trim() !== ""
        ).map((l) => ({ name: l.name, url: l.url })),
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
    <form on:submit={onSubmit}>
      <div class="flex flex-col gap-4">
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
                "border-accent-foreground": dropzone.isDragActive,
              }}
            >
              <AvatarImage
                src={appendCacheBuster(avatarUrl() ?? account()?.avatarUrl)}
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
            value={account()?.username}
            disabled={account()?.usernameChanged != null}
          />
          <TextFieldDescription class="leading-6">
            {t`Your username will be used to create your profile URL and your fediverse handle.`}
            {" "}
            <strong>
              {t`You can change it only once, and the old username will become available to others.`}
              <Show when={account()?.usernameChanged}>
                {(changed) => (
                  <>
                    {" "}
                    <Trans
                      message={t`As you have already changed it ${"CHANGED"}, you can't change it again.`}
                      values={{
                        CHANGED: () => <Timestamp value={changed()} />,
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
            value={account()?.name}
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
            value={account()?.bio}
            rows={7}
          />
          <TextFieldDescription class="leading-6">
            {t`Your bio will be displayed on your profile. You can use Markdown to format it.`}
          </TextFieldDescription>
        </TextField>
        <For each={links.links}>
          {(link, i) => (
            <LinkItemForm
              index={link.index}
              name={link.name}
              url={link.url}
              description={i() + 1 >= links.links.length}
              onChange={onLinkItemChange}
            />
          )}
        </For>
        <div class="flex flex-row gap-1.5">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-6 stroke-muted-foreground"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
            />
          </svg>
          <p class="text-sm text-muted-foreground">
            <Trans
              message={t`Note that you can verify your links belong to you by making the linked pages also link to your Hackers' Pub profile with ${"REL_ME_ATTR"} attribute.`}
              values={{
                REL_ME_ATTR: () => <code>rel="me"</code>,
              }}
            />
          </p>
        </div>
        <Button
          type="submit"
          class="cursor-pointer"
          disabled={saving()}
        >
          {saving() ? t`Saving…` : t`Save`}
        </Button>
      </div>
    </form>
  );
}

interface LinkItemFormProps {
  index: number;
  name?: string;
  url?: string;
  description?: boolean;
  required?: boolean;
  onChange?(values: { name: string; url: string; index: number }): void;
}

function LinkItemForm(props: LinkItemFormProps) {
  const { t } = useLingui();
  let nameInput: HTMLInputElement | undefined;
  let urlInput: HTMLInputElement | undefined;
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex flex-row gap-4">
        <TextField class="flex flex-col w-full gap-1.5">
          <TextFieldLabel for={`link-name-${props.index}`}>
            {t`Link name`}
          </TextFieldLabel>
          <TextFieldInput
            ref={nameInput}
            type="text"
            id={`link-name-${props.index}`}
            placeholder={t`Website`}
            value={props.name}
            required={props.required ||
              props.url != null && props.url.trim() !== ""}
            on:input={() =>
              props?.onChange?.({
                name: nameInput?.value ?? "",
                url: urlInput?.value ?? "",
                index: props.index,
              })}
          />
          <Show when={props.description}>
            <TextFieldDescription class="leading-6 grow">
              {t`A name for the link that will be displayed on your profile, e.g., GitHub.`}
            </TextFieldDescription>
          </Show>
        </TextField>
        <TextField class="flex flex-col w-full gap-1.5">
          <TextFieldLabel for={`link-url-${props.index}`}>
            {t`URL`}
          </TextFieldLabel>
          <TextFieldInput
            ref={urlInput}
            type="url"
            id={`link-url-${props.index}`}
            placeholder="https://example.com/"
            value={props.url}
            required={props.name != null && props.name.trim() !== ""}
            on:input={() =>
              props?.onChange?.({
                name: nameInput?.value ?? "",
                url: urlInput?.value ?? "",
                index: props.index,
              })}
          />
          <Show when={props.description}>
            <TextFieldDescription class="leading-6 grow">
              {t`The URL of the link, e.g., https://github.com/yourhandle.`}
            </TextFieldDescription>
          </Show>
        </TextField>
      </div>
      <Show
        when={!props.description &&
          (props.name == null || props.name.trim() === "") &&
          (props.url == null || props.url.trim() === "")}
      >
        <p class="leading-6 text-sm text-muted-foreground">
          {t`You can leave this empty to remove the link.`}
        </p>
      </Show>
    </div>
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

function appendCacheBuster(url: string | URL): string;
function appendCacheBuster(url: string | URL | undefined): string | undefined;

function appendCacheBuster(url: string | URL | undefined): string | undefined {
  if (url == null) return undefined;
  const u = url instanceof URL ? url : new URL(url);
  u.searchParams.set(`_${Date.now()}`, "1");
  return u.href;
}

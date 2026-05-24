import * as DialogPrimitive from "@kobalte/core/dialog";
import { type RouteDefinition, useParams } from "@solidjs/router";
import encodeQR from "qr";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LocaleSelect } from "~/components/LocaleSelect.tsx";
import { MarkdownEditor } from "~/components/MarkdownEditor.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { inviteCreateLinkMutation } from "./__generated__/inviteCreateLinkMutation.graphql.ts";
import type { inviteDeleteLinkMutation } from "./__generated__/inviteDeleteLinkMutation.graphql.ts";
import type { inviteInviteeList_invitees$key } from "./__generated__/inviteInviteeList_invitees.graphql.ts";
import type {
  InviteEmailError,
  InviteInviterError,
  inviteMutation,
} from "./__generated__/inviteMutation.graphql.ts";
import type { invitePageQuery } from "./__generated__/invitePageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const invitePageQuery = graphql`
  query invitePageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      invitationsLeft
      inviteesCount: invitees {
        totalCount
      }
      invitationLinks {
        id
        uuid
        url
        invitationsLeft
        message
        messageHtml
        created
        expires
      }
      ...SettingsTabs_account
      ...inviteInviteeList_invitees
    }
    ...LocaleSelect_availableLocales
  }
`;

const loadInvitePageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<invitePageQuery>(
      useRelayEnvironment()(),
      invitePageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadInvitePageQuery",
);

const inviteMutation = graphql`
  mutation inviteMutation(
    $email: Email!,
    $locale: Locale!,
    $message: Markdown,
    $verifyUrl: URITemplate!
  ) {
    invite(
      email: $email,
      locale: $locale,
      message: $message,
      verifyUrl: $verifyUrl,
    ) {
      __typename
      ... on Invitation {
        inviter {
          id
          invitationsLeft
        }
      }
      ... on InviteValidationErrors {
        account: inviter
        email
        verifyUrl
        emailOwner {
          name
          handle
          username
        }
      }
    }
  }
`;

const createInvitationLinkMutation = graphql`
  mutation inviteCreateLinkMutation(
    $invitationsLeft: Int!,
    $message: Markdown,
    $expires: String
  ) {
    createInvitationLink(
      invitationsLeft: $invitationsLeft,
      message: $message,
      expires: $expires,
    ) {
      __typename
      ... on InvitationLinkPayload {
        invitationLink {
          id
          uuid
          url
          invitationsLeft
          message
          messageHtml
          created
          expires
        }
        account {
          id
          invitationsLeft
        }
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

const deleteInvitationLinkMutation = graphql`
  mutation inviteDeleteLinkMutation($id: UUID!) {
    deleteInvitationLink(id: $id) {
      __typename
      ... on InvitationLinkPayload {
        account {
          id
          invitationsLeft
        }
      }
      ... on InvitationLinkNotFoundError {
        message
      }
    }
  }
`;

const EXPIRATION_OPTIONS: {
  unit: Intl.RelativeTimeFormatUnit;
  value: number;
  expiresString: string;
}[] = [
  { unit: "hour", value: 1, expiresString: "1 hours" },
  { unit: "hour", value: 6, expiresString: "6 hours" },
  { unit: "hour", value: 12, expiresString: "12 hours" },
  { unit: "hour", value: 24, expiresString: "24 hours" },
  { unit: "day", value: 2, expiresString: "2 days" },
  { unit: "day", value: 3, expiresString: "3 days" },
  { unit: "day", value: 7, expiresString: "7 days" },
  { unit: "week", value: 2, expiresString: "2 weeks" },
  { unit: "week", value: 3, expiresString: "3 weeks" },
  { unit: "month", value: 1, expiresString: "1 months" },
  { unit: "month", value: 2, expiresString: "2 months" },
  { unit: "month", value: 3, expiresString: "3 months" },
  { unit: "month", value: 6, expiresString: "6 months" },
  { unit: "month", value: 12, expiresString: "12 months" },
];

export default function InvitePage() {
  const params = useParams();
  const { t, i18n } = useLingui();

  const data = createPreloadedQuery<invitePageQuery>(
    invitePageQuery,
    () => loadInvitePageQuery(params.handle!),
  );
  const [inviterError, setInviterError] = createSignal<
    InviteInviterError | undefined
  >();
  const [email, setEmail] = createSignal("");
  const [emailError, setEmailError] = createSignal<
    InviteEmailError | undefined
  >();
  const [emailOwner, setEmailOwner] = createSignal<
    { name: string; handle: string; username: string } | undefined
  >();
  const [invitationLanguage, setInvitationLanguage] = createSignal(i18n.locale);
  const [message, setMessage] = createSignal("");
  const [send] = createMutation<inviteMutation>(inviteMutation);
  const [sending, setSending] = createSignal(false);
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSending(true);
    send({
      variables: {
        email: email(),
        locale: invitationLanguage(),
        message: message().trim() === "" ? null : message().trim(),
        verifyUrl: `${
          globalThis.location?.origin ?? "https://hackers.pub"
        }/sign/up/{token}?code={code}`,
      },
      onCompleted({ invite }) {
        setSending(false);
        if (invite.__typename === "InviteValidationErrors") {
          setInviterError(invite.account ?? undefined);
          setEmailError(invite.email ?? undefined);
          setEmailOwner(invite.emailOwner ?? undefined);
          showToast({
            variant: "error",
            title: t`Failed to send invitation`,
            description: t`Please correct the errors and try again.`,
          });
        } else {
          setInviterError(undefined);
          setEmailError(undefined);
          setEmailOwner(undefined);
          setEmail("");
          setMessage("");
          showToast({
            title: t`Invitation sent`,
            description: t`The invitation has been sent successfully.`,
          });
        }
      },
      onError(error) {
        console.error(error);
        setSending(false);
        showToast({
          variant: "error",
          title: t`Failed to send invitation`,
          description:
            t`An unexpected error occurred. Please try again later.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        });
      },
    });
  }

  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          viewerId={data.viewer?.id}
        >
          {
            /* `keyed` avoids a "Stale read from <Show>" race when solid-relay
             publishes a fragment snapshot inside `batch()` that flips
             `accountByUsername` to falsy in the same tick as a downstream
             reactive read. Reconcile keeps the account's identity stable
             (`key: "__id"`), so `keyed` only re-mounts on navigation to
             a different account. */
          }
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Invite`}</Title>
                <NarrowContainer class="p-4">
                  <SettingsTabs
                    selected="invite"
                    $account={account}
                  />
                  <Card class="mt-4">
                    <CardHeader>
                      <CardTitle>
                        {t`Invite a friend`}
                      </CardTitle>
                      <CardDescription>
                        <Show
                          when={account.invitationsLeft > 0}
                          fallback={t`You have no invitations left. Please wait until you receive more.`}
                        >
                          {i18n._(msg`${
                            plural(account.invitationsLeft, {
                              one:
                                "Invite your friends to Hackers' Pub. You can invite up to # person.",
                              other:
                                "Invite your friends to Hackers' Pub. You can invite up to # people.",
                            })
                          }`)}
                        </Show>
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form
                        on:submit={onSubmit}
                        class="flex flex-col gap-4"
                      >
                        <TextField
                          class="grid w-full items-center gap-1.5"
                          validationState={emailError() == null
                            ? "valid"
                            : "invalid"}
                        >
                          <TextFieldLabel for="email">
                            {t`Email address`}
                          </TextFieldLabel>
                          <TextFieldInput
                            type="email"
                            required
                            id="email"
                            placeholder="yourfriend@email.com"
                            value={email()}
                            onInput={(e) => setEmail(e.currentTarget.value)}
                          />
                          <Switch>
                            <Match when={emailError() == null}>
                              <TextFieldDescription class="leading-6">
                                {t`The email address is not only used for receiving the invitation, but also for signing in to the account.`}
                              </TextFieldDescription>
                            </Match>
                            <Match when={emailError() === "EMAIL_INVALID"}>
                              <TextFieldErrorMessage class="leading-6">
                                {t`The email address is invalid.`}
                              </TextFieldErrorMessage>
                            </Match>
                            <Match
                              when={emailError() === "EMAIL_ALREADY_TAKEN" &&
                                emailOwner() != null}
                            >
                              <TextFieldErrorMessage class="leading-6">
                                <Trans
                                  message={t`${"USER"} is already a member of Hackers' Pub.`}
                                  values={{
                                    USER: () => (
                                      <a href={`/@${emailOwner()?.username}`}>
                                        <strong>{emailOwner()?.name}</strong>
                                        {" "}
                                        <span class="opacity-75">
                                          ({emailOwner()?.handle})
                                        </span>
                                      </a>
                                    ),
                                  }}
                                />
                              </TextFieldErrorMessage>
                            </Match>
                          </Switch>
                        </TextField>
                        <div class="flex flex-col gap-1.5">
                          <Label>{t`Invitation language`}</Label>
                          <LocaleSelect
                            $availableLocales={data}
                            value={invitationLanguage()}
                            onChange={setInvitationLanguage}
                          />
                          <p class="text-sm text-muted-foreground">
                            {t`Choose the language your friend prefers. This language will only be used for the invitation.`}
                          </p>
                        </div>
                        <TextField class="grid w-full items-center gap-1.5">
                          <TextFieldLabel for="message">
                            {t`Extra message`}
                          </TextFieldLabel>
                          <TextFieldTextArea
                            id="message"
                            value={message()}
                            onInput={(e) => setMessage(e.currentTarget.value)}
                            placeholder={t`You can leave this field empty.`}
                          />
                          <TextFieldDescription class="leading-6">
                            {t`Your friend will see this message in the invitation email.`}
                          </TextFieldDescription>
                        </TextField>
                        <Button
                          type="submit"
                          class="cursor-pointer"
                          disabled={sending() ||
                            account.invitationsLeft <= 0}
                        >
                          {account.invitationsLeft <= 0
                            ? t`No invitations left`
                            : sending()
                            ? t`Sending…`
                            : t`Send`}
                        </Button>
                        <Show
                          when={inviterError() ===
                            "INVITER_NO_INVITATIONS_LEFT"}
                        >
                          <p class="text-sm text-destructive">
                            {t`You have no invitations left. Please wait until you receive more.`}
                          </p>
                        </Show>
                      </form>
                    </CardContent>
                  </Card>
                  <InvitationLinksCard
                    accountId={account.id}
                    username={account.username}
                    invitationLinks={account.invitationLinks}
                    invitationsLeft={account.invitationsLeft}
                  />
                  <Show when={account.inviteesCount.totalCount > 0}>
                    <Card class="mt-4">
                      <CardHeader>
                        <CardTitle>{t`Users you have invited`}</CardTitle>
                        <CardDescription>
                          {i18n._(
                            msg`${
                              plural(account.inviteesCount.totalCount, {
                                one: "You have invited total # person so far.",
                                other:
                                  "You have invited total # people so far.",
                              })
                            }`,
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <InviteeList $invitees={account} />
                      </CardContent>
                    </Card>
                  </Show>
                </NarrowContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

type UUID = `${string}-${string}-${string}-${string}-${string}`;

interface InvitationLinksCardProps {
  readonly accountId: string;
  readonly username: string;
  readonly invitationLinks: ReadonlyArray<{
    readonly id: string;
    readonly uuid: UUID;
    readonly url: string;
    readonly invitationsLeft: number;
    readonly message: string | null | undefined;
    readonly messageHtml: string | null | undefined;
    readonly created: string;
    readonly expires: string | null | undefined;
  }>;
  readonly invitationsLeft: number;
}

function InvitationLinksCard(props: InvitationLinksCardProps) {
  const { t, i18n } = useLingui();
  const [createLink] = createMutation<inviteCreateLinkMutation>(
    createInvitationLinkMutation,
  );
  const [deleteLink] = createMutation<inviteDeleteLinkMutation>(
    deleteInvitationLinkMutation,
  );
  const [linkCount, setLinkCount] = createSignal(1);
  const [linkMessage, setLinkMessage] = createSignal("");
  const [linkExpires, setLinkExpires] = createSignal(
    EXPIRATION_OPTIONS[0].expiresString,
  );
  const [creating, setCreating] = createSignal(false);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [qrUrl, setQrUrl] = createSignal<string | null>(null);

  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "always" });

  function onCreateLink(event: SubmitEvent) {
    event.preventDefault();
    setCreating(true);
    createLink({
      variables: {
        invitationsLeft: linkCount(),
        message: linkMessage().trim() === "" ? null : linkMessage().trim(),
        expires: linkExpires() === "" ? null : linkExpires(),
      },
      updater(store) {
        const payload = store.getRootField("createInvitationLink");
        if (payload == null) return;
        const newLink = payload.getLinkedRecord("invitationLink");
        if (newLink == null) return;
        const account = store.get(props.accountId);
        if (account == null) return;
        const existingLinks = account.getLinkedRecords("invitationLinks") ?? [];
        account.setLinkedRecords(
          [newLink, ...existingLinks],
          "invitationLinks",
        );
      },
      onCompleted(data) {
        setCreating(false);
        if (
          data.createInvitationLink.__typename === "InvitationLinkPayload"
        ) {
          setLinkCount(1);
          setLinkMessage("");
          setLinkExpires(EXPIRATION_OPTIONS[0].expiresString);
          showToast({
            title: t`Invitation link created`,
            description: t`The invitation link has been created successfully.`,
          });
        } else if (
          data.createInvitationLink.__typename === "InvalidInputError"
        ) {
          showToast({
            variant: "error",
            title: t`Failed to create invitation link`,
            description: t`Please correct the errors and try again.`,
          });
        }
      },
      onError(error) {
        console.error(error);
        setCreating(false);
        showToast({
          variant: "error",
          title: t`Failed to create invitation link`,
          description:
            t`An unexpected error occurred. Please try again later.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        });
      },
    });
  }

  function onDeleteLink(id: UUID, relayId: string) {
    setDeletingId(id);
    deleteLink({
      variables: { id },
      updater(store) {
        const result = store.getRootField("deleteInvitationLink");
        if (result == null) return;
        const typename = result.getValue("__typename");
        if (typename !== "InvitationLinkPayload") return;
        const account = store.get(props.accountId);
        if (account == null) return;
        const existingLinks = account.getLinkedRecords("invitationLinks") ?? [];
        account.setLinkedRecords(
          existingLinks.filter((link) => link.getDataID() !== relayId),
          "invitationLinks",
        );
        store.delete(relayId);
      },
      onCompleted(data) {
        setDeletingId(null);
        if (
          data.deleteInvitationLink.__typename === "InvitationLinkPayload"
        ) {
          showToast({
            title: t`Invitation link deleted`,
            description: t`The invitation link has been deleted successfully.`,
          });
        } else {
          showToast({
            variant: "error",
            title: t`Failed to delete invitation link`,
            description:
              t`The invitation link could not be found or you are not authorized to delete it.`,
          });
        }
      },
      onError(error) {
        console.error(error);
        setDeletingId(null);
        showToast({
          variant: "error",
          title: t`Failed to delete invitation link`,
          description:
            t`An unexpected error occurred. Please try again later.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
        });
      },
    });
  }

  function copyToClipboard(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      showToast({
        title: t`Copied`,
        description: t`The invitation link has been copied to the clipboard.`,
      });
    }).catch(() => {
      showToast({
        variant: "error",
        title: t`Failed to copy`,
        description: t`Could not copy the link to the clipboard.`,
      });
    });
  }

  return (
    <Card class="mt-4">
      <CardHeader>
        <CardTitle>{t`Invitation links`}</CardTitle>
        <CardDescription>
          {t`Create shareable invitation links. Each link can be used multiple times until the invitation count runs out or the link expires.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DialogPrimitive.Root
          open={qrUrl() !== null}
          onOpenChange={(open) => {
            if (!open) setQrUrl(null);
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
            <DialogPrimitive.Content
              class="fixed inset-0 z-50 flex items-center justify-center outline-none data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0"
              onClick={(e: MouseEvent) => {
                if (e.target === e.currentTarget) setQrUrl(null);
              }}
            >
              <DialogPrimitive.Title class="sr-only">
                {t`QR code`}
              </DialogPrimitive.Title>
              <DialogPrimitive.CloseButton class="absolute right-4 top-4 rounded-full bg-white/10 p-1.5 text-white/90 transition-colors hover:bg-white/20 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/50">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="size-6"
                >
                  <path d="M18 6l-12 12" />
                  <path d="M6 6l12 12" />
                </svg>
                <span class="sr-only">{t`Close`}</span>
              </DialogPrimitive.CloseButton>
              <Show when={qrUrl()}>
                {(url) => (
                  <div class="flex max-h-[95vh] max-w-[95vw] flex-col items-center gap-4 p-4">
                    <div
                      class="aspect-square max-h-[85vh] w-full max-w-[85vh] [&>svg]:h-full [&>svg]:w-full [&>svg]:invert"
                      innerHTML={encodeQR(url(), "svg", { border: 4 })}
                    />
                    <code class="max-w-full break-all text-center text-xs text-white/70">
                      {url()}
                    </code>
                  </div>
                )}
              </Show>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <Show when={props.invitationLinks.length > 0}>
          <ul class="flex flex-col gap-3 mb-6">
            <For each={props.invitationLinks}>
              {(link) => {
                const linkUrl = () =>
                  `${
                    globalThis.location?.origin ?? ""
                  }/@${props.username}/invite/${link.uuid}`;
                const isExpired = link.invitationsLeft < 1 ||
                  (link.expires != null &&
                    new Date(link.expires) < new Date());
                return (
                  <li class="flex flex-col gap-1.5 rounded-md border p-3">
                    <div class="flex items-center gap-2">
                      <code class="flex-1 truncate text-sm bg-muted px-2 py-1 rounded">
                        {linkUrl()}
                      </code>
                      <Show when={!isExpired}>
                        <Button
                          variant="outline"
                          size="sm"
                          class="cursor-pointer shrink-0"
                          on:click={() => copyToClipboard(linkUrl())}
                        >
                          {t`Copy`}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          class="cursor-pointer shrink-0"
                          on:click={() => setQrUrl(linkUrl())}
                        >
                          {t`QR code`}
                        </Button>
                      </Show>
                      <Button
                        variant="destructive"
                        size="sm"
                        class="cursor-pointer shrink-0"
                        disabled={deletingId() === link.uuid}
                        on:click={() => onDeleteLink(link.uuid, link.id)}
                      >
                        {deletingId() === link.uuid ? t`Deleting…` : t`Delete`}
                      </Button>
                    </div>
                    {
                      /* `keyed`: avoid Solid's stale-accessor race when
                       this Relay field flips to null inside a `batch()`
                       update. */
                    }
                    <Show keyed when={link.messageHtml}>
                      {(html) => (
                        <div
                          class="prose dark:prose-invert prose-sm max-w-none truncate text-muted-foreground"
                          innerHTML={html}
                        />
                      )}
                    </Show>
                    <div class="flex gap-4 text-sm text-muted-foreground">
                      <span>
                        {i18n._(
                          msg`${
                            plural(link.invitationsLeft, {
                              one: "# invitation left",
                              other: "# invitations left",
                            })
                          }`,
                        )}
                      </span>
                      <span>
                        {/* `keyed`: same race shape; expires can flip to null. */}
                        <Show
                          keyed
                          when={link.expires}
                          fallback={t`Never expires`}
                        >
                          {(expires) => (
                            <Trans
                              message={t`Expires ${"DATE"}`}
                              values={{
                                DATE: () => (
                                  <Timestamp
                                    value={expires}
                                    allowFuture
                                  />
                                ),
                              }}
                            />
                          )}
                        </Show>
                      </span>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <form on:submit={onCreateLink} class="flex flex-col gap-4">
          <TextField class="grid w-full items-center gap-1.5">
            <TextFieldLabel for="linkInvitationsLeft">
              {t`Number of invitations`}
            </TextFieldLabel>
            <TextFieldInput
              type="number"
              id="linkInvitationsLeft"
              min={1}
              max={props.invitationsLeft}
              value={linkCount()}
              onInput={(e) =>
                setLinkCount(parseInt(e.currentTarget.value) || 1)}
            />
          </TextField>
          <TextField class="grid w-full items-center gap-1.5">
            <TextFieldLabel for="linkMessage">
              {t`Extra message`}
            </TextFieldLabel>
            <MarkdownEditor
              id="linkMessage"
              value={linkMessage()}
              onInput={setLinkMessage}
              placeholder={t`You can leave this field empty.`}
            />
          </TextField>
          <div class="flex flex-col gap-1.5">
            <Label for="linkExpires">{t`Expiry`}</Label>
            <select
              id="linkExpires"
              class="flex h-10 w-full items-center rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              value={linkExpires()}
              onChange={(e) => setLinkExpires(e.currentTarget.value)}
            >
              <For each={EXPIRATION_OPTIONS}>
                {(opt) => (
                  <option value={opt.expiresString}>
                    {rtf.format(opt.value, opt.unit)}
                  </option>
                )}
              </For>
              <option value="">
                {t`Never expires`}
              </option>
            </select>
          </div>
          <Button
            type="submit"
            class="cursor-pointer"
            disabled={creating() || props.invitationsLeft <= 0}
          >
            {props.invitationsLeft <= 0
              ? t`No invitations left`
              : creating()
              ? t`Creating…`
              : t`Create invitation link`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface InviteeListProps {
  readonly $invitees: inviteInviteeList_invitees$key;
}

function InviteeList(props: InviteeListProps) {
  const { t } = useLingui();
  const invitees = createPaginationFragment(
    graphql`
      fragment inviteInviteeList_invitees on Account
        @refetchable(queryName: "inviteInviteeListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        __id
        invitees(after: $cursor, first: $count)
          @connection(key: "inviteInviteeList_invitees")
        {
          edges {
            __id
            node {
              id
              name
              username
              avatarUrl
              actor {
                handle
              }
              created
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$invitees,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    invitees.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div>
      <Show keyed when={invitees()}>
        {(data) => (
          <>
            <ul class="flex flex-col gap-2">
              <For each={data.invitees.edges}>
                {({ node }) => (
                  <li class="flex flex-row gap-1.5">
                    <Avatar>
                      <a href={`/@${node.username}`}>
                        <AvatarImage src={node.avatarUrl} />
                      </a>
                    </Avatar>
                    <div class="flex flex-col">
                      <a href={`/@${node.username}`}>
                        <span class="font-semibold">{node.name}</span>
                        <span class="text-sm text-muted-foreground pl-1.5">
                          {node.actor.handle}
                        </span>
                      </a>
                      <a
                        href={`/@${node.username}`}
                        class="text-sm text-muted-foreground"
                      >
                        <Trans
                          message={t`Joined on ${"DATE"}`}
                          values={{
                            DATE: () => <Timestamp value={node.created} />,
                          }}
                        />
                      </a>
                    </div>
                  </li>
                )}
              </For>
            </ul>
            <Show when={data.invitees.pageInfo.hasNextPage}>
              <Button
                variant="outline"
                class="mt-4 cursor-pointer w-full"
                on:click={invitees.pending || loadingState() === "loading"
                  ? undefined
                  : onLoadMore}
              >
                <Switch>
                  <Match
                    when={invitees.pending || loadingState() === "loading"}
                  >
                    {t`Loading more invitees…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more invitees; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more invitees`}
                  </Match>
                </Switch>
              </Button>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

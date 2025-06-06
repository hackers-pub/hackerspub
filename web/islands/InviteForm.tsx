import type { Account, Actor } from "@hackerspub/models/schema";
import { getFixedT } from "i18next";
import { useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { TextArea } from "../components/TextArea.tsx";
import { type Language, SUPPORTED_LANGUAGES } from "../i18n.ts";

type AccountView = Pick<Account, "username" | "name" | "id">;
type ActorView = Pick<Actor, "avatarUrl">;

export type AccountWithInvitationInfo = Omit<AccountView, "id"> & {
  leftInvitations: number;
  inviter: AccountView & { actor: ActorView } | null;
  invitees: (AccountView & { actor: ActorView })[];
};

export type InviteFormProps =
  & {
    language: Language;
    account: AccountWithInvitationInfo;
    canonicalHost: string;
  }
  & (
    | { success?: undefined }
    | { success: false; error: "noLeftInvitations" | "emailRequired" }
    | {
      success: false;
      error: "alreadyExists";
      existingAccount: Omit<AccountView, "id">;
    }
    | { success: true; email: string }
  );

export function InviteForm(
  { language, ...initialData }: InviteFormProps,
) {
  const [data, setData] = useState(initialData);
  const t = getFixedT(language);
  const [sending, setSending] = useState(false);
  const [email, setEmail] = useState("");
  const [invitationLanguage, setInvitationLanguage] = useState(language);
  const [extraMessage, setExtraMessage] = useState("");
  const languageDisplayNames = new Intl.DisplayNames(language, {
    type: "language",
  });
  const account = data.account;
  const { leftInvitations } = account;

  async function onClickSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (sending) {
      return;
    }

    const form = event.currentTarget as HTMLFormElement;
    const body = new FormData(form);

    setSending(true);

    const response = await fetch(form.target, {
      method: form.method,
      body,
      headers: {
        accept: "application/json",
      },
    }).finally(() => {
      setEmail("");
      setSending(false);
    });
    const parsedData = await response.json();
    setData(parsedData);
  }

  const disabledForm = leftInvitations < 1 || sending;

  return (
    <TranslationSetup language={language}>
      <form method="post" onSubmit={onClickSubmit}>
        {data.success === false
          ? (
            <p class="mt-4 text-red-700 dark:text-red-500">
              {data.error === "noLeftInvitations"
                ? <Msg $key="settings.invite.noLeftInvitations" />
                : data.error === "emailRequired"
                ? <Msg $key="settings.invite.emailRequired" />
                : data.error === "alreadyExists"
                ? (
                  <Msg
                    $key="settings.invite.alreadyExists"
                    account={
                      <a href={`/@${data.existingAccount.username}`}>
                        <strong>{data.existingAccount.name}</strong>
                        <span class="opacity-50 ml-1 before:content-['('] after:content-[')']">
                          @{data.existingAccount.username}@{"host"}
                        </span>
                      </a>
                    }
                  />
                )
                : undefined}
            </p>
          )
          : (
            <p class="mt-4">
              {data.success
                ? (
                  <Msg
                    $key="settings.invite.success"
                    email={<strong>{data.email}</strong>}
                    count={leftInvitations}
                  />
                )
                : (
                  <Msg
                    $key="settings.invite.description"
                    count={leftInvitations}
                  />
                )}
            </p>
          )}
        <div class="mt-4 grid md:grid-cols-2 gap-5">
          <div>
            <Label label={t("settings.invite.email")} required>
              <Input
                type="email"
                name="email"
                required
                disabled={disabledForm}
                value={email}
                onInput={(e) => setEmail(e.currentTarget.value)}
                class="w-full"
              />
            </Label>
            <p class="opacity-50">
              <Msg $key="settings.invite.emailDescription" />
            </p>
          </div>
          <div>
            <Label label={t("settings.invite.language")} required>
              <select
                name="language"
                class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
                value={invitationLanguage}
                onChange={(e) =>
                  setInvitationLanguage(e.currentTarget.value as Language)}
              >
                {SUPPORTED_LANGUAGES
                  .map((l) =>
                    [l, languageDisplayNames.of(l) ?? l] satisfies [
                      Language,
                      string,
                    ]
                  )
                  .toSorted(([_, a], [__, b]) => a.localeCompare(b, language))
                  .map(([l, name]) => {
                    const nativeName = new Intl.DisplayNames(l, {
                      type: "language",
                    }).of(l);
                    return (
                      <option key={l} value={l} selected={l === language}>
                        {nativeName === name ? name : `${name} (${nativeName})`}
                      </option>
                    );
                  })}
              </select>
            </Label>
            <p class="opacity-50">
              <Msg $key="settings.invite.languageDescription" />
            </p>
          </div>
        </div>
        <div class="mt-4">
          <Label label={t("settings.invite.extraMessage")}>
            <TextArea
              name="message"
              rows={4}
              cols={80}
              value={extraMessage}
              onInput={(e) => setExtraMessage(e.currentTarget.value)}
              disabled={disabledForm}
              class="w-full lg:w-auto"
            />
          </Label>
          <p class="opacity-50">
            <Msg $key="settings.invite.extraMessageDescription" />
          </p>
        </div>
        <div class="mt-4">
          <Button type="submit" disabled={disabledForm}>
            <Msg $key="settings.invite.send" />
          </Button>
        </div>
      </form>
    </TranslationSetup>
  );
}

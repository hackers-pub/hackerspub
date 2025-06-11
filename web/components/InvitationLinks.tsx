import { preprocessContentHtml } from "@hackerspub/models/html";
import type { RenderedMarkup } from "@hackerspub/models/markup";
import type { InvitationLink } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { Timestamp } from "../islands/Timestamp.tsx";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Msg, Translation } from "./Msg.tsx";
import { PageTitle } from "./PageTitle.tsx";
import { TextArea } from "./TextArea.tsx";

const EXPIRATION_OPTIONS: {
  unit: Intl.RelativeTimeFormatUnit;
  value: number;
}[] = [
  { unit: "hours", value: 1 },
  { unit: "hours", value: 6 },
  { unit: "hours", value: 12 },
  { unit: "hours", value: 24 },
  { unit: "days", value: 2 },
  { unit: "days", value: 3 },
  { unit: "days", value: 7 },
  { unit: "weeks", value: 2 },
  { unit: "weeks", value: 3 },
  { unit: "months", value: 1 },
  { unit: "months", value: 2 },
  { unit: "months", value: 3 },
  { unit: "months", value: 6 },
  { unit: "months", value: 12 },
];

export interface InvitationLinksProps {
  account: { username: string; leftInvitations: number };
  invitationLinks: InvitationLink[];
  messages: Record<Uuid, RenderedMarkup>;
}

export function InvitationLinks(
  { account, invitationLinks, messages }: InvitationLinksProps,
) {
  const { leftInvitations } = account;
  invitationLinks = invitationLinks.toSorted((a, b) => +a.created - +b.created);
  return (
    <Translation>
      {(t, language) => {
        const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
        return (
          <form action={`/@${account.username}/invite`} method="POST">
            <PageTitle
              class="mt-8"
              subtitle={{
                text: t("settings.invite.invitationLinksDescription"),
              }}
            >
              <Msg $key="settings.invite.invitationLinks" />
            </PageTitle>
            <table class="table table-auto border-collapse border border-stone-300 dark:border-stone-500 w-full">
              <thead>
                <tr>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2 w-18">
                    <Msg $key="settings.invite.link" />
                  </th>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2 max-w-[65ch]">
                    <Msg $key="settings.invite.extraMessage" />
                  </th>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                    <Msg $key="settings.invite.invitationsLeft" />
                  </th>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                    <Msg $key="settings.invite.expires" />
                  </th>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-200 dark:bg-stone-700 p-2">
                    <Msg $key="settings.invite.createOrDelete" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitationLinks.map((link) => (
                  <tr>
                    <th class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2 w-18">
                      <a
                        href={`/@${account.username}/invite/${link.id}`}
                        target="_blank"
                        class="underline"
                      >
                        <Msg $key="settings.invite.link" />
                      </a>
                    </th>
                    <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2 max-w-[65ch]">
                      {link.message != null && link.id in messages && (
                        <div
                          class="prose dark:prose-invert max-w-none"
                          dangerouslySetInnerHTML={{
                            __html: preprocessContentHtml(
                              messages[link.id].html,
                              {
                                mentions: Object.values(
                                  messages[link.id].mentions,
                                ).map((actor) => ({ actor })),
                                tags: {},
                              },
                            ),
                          }}
                        />
                      )}
                    </td>
                    <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                      {link.invitationsLeft.toLocaleString(language)}
                    </td>
                    <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                      {link.expires
                        ? (
                          <Timestamp
                            value={link.expires}
                            locale={language}
                            allowFuture
                          />
                        )
                        : <Msg $key="settings.invite.neverExpires" />}
                    </td>
                    <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                      <Button
                        type="submit"
                        name="id"
                        value={link.id}
                        formaction={`/@${account.username}/invite/${link.id}/delete`}
                      >
                        <Msg $key="settings.invite.delete" />
                      </Button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <th class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2 w-18">
                  </th>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2 max-w-[65ch]">
                    <TextArea
                      name="message"
                      cols={80}
                      rows={7}
                      class="w-full"
                    >
                    </TextArea>
                    <p>
                      <a
                        href="/markdown"
                        target="_blank"
                        class="flex flex-row items-center w-fit opacity-50 hover:opacity-100"
                      >
                        <svg
                          fill="currentColor"
                          height="128"
                          viewBox="0 0 208 128"
                          width="208"
                          xmlns="http://www.w3.org/2000/svg"
                          class="size-8 mr-2 shrink-0"
                          stroke="currentColor"
                        >
                          <g>
                            <path
                              clip-rule="evenodd"
                              d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                              fill-rule="evenodd"
                            />
                            <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
                          </g>
                        </svg>
                        <span class="hidden xl:block">
                          <Msg $key="settings.invite.markdownEnabled" />
                        </span>
                      </a>
                    </p>
                  </td>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    <Input
                      name="invitationsLeft"
                      type="number"
                      step={1}
                      min={1}
                      max={leftInvitations}
                      value={leftInvitations}
                      disabled={account.leftInvitations < 1}
                      class="w-16"
                    />
                  </td>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    <select
                      name="expires"
                      disabled={account.leftInvitations < 1}
                      class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
                    >
                      {EXPIRATION_OPTIONS.map(({ unit, value }) => (
                        <option
                          key={`${unit}-${value}`}
                          value={`${value} ${unit}`}
                        >
                          {rtf.format(value, unit)}
                        </option>
                      ))}
                      <option value="">
                        <Msg $key="settings.invite.neverExpires" />
                      </option>
                    </select>
                  </td>
                  <td class="border border-stone-300 dark:border-stone-500 bg-stone-100 dark:bg-stone-800 p-2">
                    <Button
                      type="submit"
                      disabled={account.leftInvitations < 1}
                    >
                      <Msg $key="settings.invite.create" />
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </form>
        );
      }}
    </Translation>
  );
}

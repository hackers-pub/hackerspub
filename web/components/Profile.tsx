import type { Relationship } from "@hackerspub/models/account";
import { getAvatarUrl } from "@hackerspub/models/avatar";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { preprocessContentHtml, sanitizeHtml } from "@hackerspub/models/html";
import type { AccountLink, Actor } from "@hackerspub/models/schema";
import { compactUrl } from "@hackerspub/models/url";
import { escape } from "@std/html/entities";
import { ConfirmForm } from "../islands/ConfirmForm.tsx";
import { Link } from "../islands/Link.tsx";
import { RemoteFollowButton } from "../islands/RemoteFollowButton.tsx";
import { Button } from "./Button.tsx";
import { Msg, Translation } from "./Msg.tsx";
import { PageTitle } from "./PageTitle.tsx";

export interface ProfileProps {
  actor: Actor & { successor: Actor | null };
  actorMentions: { actor: Actor }[];
  relationship: Relationship | null;
  links?: AccountLink[];
  profileHref: string;
  signedAccount?: { id: string; actor: { id: string } } | null;
}

export function Profile(
  { actor, actorMentions, profileHref, relationship, links, signedAccount }:
    ProfileProps,
) {
  const bioHtml = preprocessContentHtml(
    actor.bioHtml ?? "",
    {
      mentions: actorMentions,
      emojis: actor.emojis,
      tags: actor.tags,
    },
  );
  return (
    <Translation>
      {(t, language) => (
        <>
          {relationship?.incoming === "block"
            ? (
              <div class="mb-4 p-4 bg-stone-100 dark:bg-stone-800">
                <Msg $key="profile.blockedDescription" />
              </div>
            )
            : relationship?.outgoing === "block"
            ? (
              <div class="mb-4 p-4 bg-stone-100 dark:bg-stone-800">
                <Msg $key="profile.blockingDescription" />
              </div>
            )
            : actor.successor != null
            ? (
              <div class="mb-4 p-4 bg-stone-100 dark:bg-stone-800">
                <Msg
                  $key="profile.successorDescription"
                  successor={
                    <Link
                      href={actor.successor.url ?? actor.successor.iri}
                      internalHref={actor.accountId == null
                        ? `/${actor.successor.handle}`
                        : `/@${actor.successor.username}`}
                      class="font-bold"
                    >
                      <img
                        src={getAvatarUrl(actor.successor)}
                        width={18}
                        height={18}
                        class="inline-block align-top mt-0.5 mr-1"
                        alt="Profile img"
                      />
                      {actor.successor.name == null
                        ? actor.successor.username
                        : (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: renderCustomEmojis(
                                escape(actor.successor.name),
                                actor.successor.emojis,
                              ),
                            }}
                          />
                        )}
                      <span class="opacity-50 before:content-['('] after:content-[')'] font-normal ml-1">
                        {actor.successor.handle}
                      </span>
                    </Link>
                  }
                />
              </div>
            )
            : undefined}
          <div class="flex">
            {actor.avatarUrl && relationship?.incoming !== "block" && (
              <a
                href={actor.url ?? actor.iri}
                target={actor.accountId == null ? "_blank" : undefined}
                class="shrink-0"
              >
                <img
                  src={actor.avatarUrl}
                  width={56}
                  height={56}
                  class={`mb-5 mr-4 ${
                    actor.successorId == null ? "" : "grayscale"
                  }`}
                  alt="Profile img"
                />
              </a>
            )}
            <PageTitle
              subtitle={{
                text: (
                  <>
                    <span class="select-all">{actor.handle}</span> &middot;{" "}
                    {actor.accountId == null
                      ? (
                        <Msg
                          $key="profile.followeesCount"
                          count={actor.followeesCount}
                        />
                      )
                      : (
                        <a href={`${profileHref}/following`}>
                          <Msg
                            $key="profile.followeesCount"
                            count={actor.followeesCount}
                          />
                        </a>
                      )} &middot; {actor.accountId == null
                      ? (
                        <Msg
                          $key="profile.followersCount"
                          count={actor.followersCount}
                        />
                      )
                      : (
                        <a href={`${profileHref}/followers`}>
                          <Msg
                            $key="profile.followersCount"
                            count={actor.followersCount}
                          />
                        </a>
                      )}
                    {relationship?.incoming === "follow" &&
                      (
                        <>
                          {" "}&middot; <Msg $key="profile.followsYou" />
                        </>
                      )}
                  </>
                ),
              }}
            >
              {actor.name == null
                ? (
                  <a
                    href={actor.url ?? actor.iri}
                    target={actor.accountId == null ? "_blank" : undefined}
                    class={actor.successorId == null ? "" : "grayscale"}
                  >
                    {actor.username}
                  </a>
                )
                : (
                  <a
                    href={actor.url ?? actor.iri}
                    target={actor.accountId == null ? "_blank" : undefined}
                    dangerouslySetInnerHTML={{
                      __html: renderCustomEmojis(
                        escape(actor.name),
                        actor.emojis,
                      ),
                    }}
                    class={actor.successorId == null ? "" : "grayscale"}
                  />
                )}
            </PageTitle>
            {(() => {
              // Don't show any follow buttons on own profile
              if (signedAccount?.actor.id === actor.id) {
                return null;
              }

              // Not logged in - show remote follow button
              if (signedAccount == null) {
                return (
                  <div class="shrink-0">
                    <RemoteFollowButton
                      actorHandle={actor.handle}
                      actorName={actor.name || actor.username}
                      language={language}
                    />
                  </div>
                );
              }

              // Logged in - show follow/unfollow buttons based on relationship
              if (relationship?.outgoing === "none") {
                return (
                  <form
                    method="post"
                    action={`${profileHref}/follow`}
                    class="shrink-0"
                  >
                    <Button
                      disabled={relationship?.incoming === "block"}
                      class="ml-4 mt-2 h-9"
                    >
                      {relationship?.incoming === "follow"
                        ? <Msg $key="profile.followBack" />
                        : <Msg $key="profile.follow" />}
                    </Button>
                  </form>
                );
              }

              if (
                relationship?.incoming !== "block" &&
                relationship?.outgoing !== "block"
              ) {
                return (
                  <form
                    method="post"
                    action={`${profileHref}/unfollow`}
                    class="shrink-0"
                  >
                    <Button class="ml-4 mt-2 h-9">
                      {relationship?.outgoing === "follow"
                        ? <Msg $key="profile.unfollow" />
                        : <Msg $key="profile.cancelRequest" />}
                    </Button>
                  </form>
                );
              }

              return null;
            })()}
            {relationship != null &&
              (
                <div class="pl-3 pt-3.5">
                  <div class="w-6 h-8 group">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="size-6 opacity-50 group-hover:opacity-100"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                      />
                    </svg>
                    <div class="
                      hidden group-hover:flex group-active:flex absolute z-50
                      mt-2 p-4
                      bg-stone-200 dark:bg-stone-700
                      border border-stone-400 dark:border-stone-500
                      text-stone-800 dark:text-stone-100
                      flex-col gap-4
                    ">
                      {relationship.incoming === "follow" &&
                        (
                          <ConfirmForm
                            method="post"
                            action={`@${relationship.account.username}/followers`}
                            confirm={t("profile.followerList.removeConfirm", {
                              name: actor.name ?? actor.username,
                              handle: actor.handle,
                            })}
                          >
                            <button
                              type="submit"
                              name="followerId"
                              value={actor.id}
                            >
                              <Msg $key="profile.followerList.remove" />
                            </button>
                            <input
                              type="hidden"
                              name="return"
                              value={relationship.target.accountId == null
                                ? `/${relationship.target.handle}`
                                : `/@${relationship.target.username}`}
                            />
                          </ConfirmForm>
                        )}
                      {relationship.outgoing === "block"
                        ? (
                          <ConfirmForm
                            method="post"
                            action={relationship.target.accountId == null
                              ? `/${relationship.target.handle}/unblock`
                              : `/@${relationship.target.username}/unblock`}
                            confirm={t("profile.unblockConfirm", {
                              name: actor.name ?? actor.username,
                              handle: actor.handle,
                            })}
                          >
                            <button type="submit">
                              <Msg $key="profile.unblock" />
                            </button>
                          </ConfirmForm>
                        )
                        : (
                          <ConfirmForm
                            method="post"
                            action={relationship.target.accountId == null
                              ? `/${relationship.target.handle}/block`
                              : `/@${relationship.target.username}/block`}
                            confirm={t("profile.blockConfirm", {
                              name: actor.name ?? actor.username,
                              handle: actor.handle,
                            })}
                          >
                            <button type="submit">
                              <Msg $key="profile.block" />
                            </button>
                          </ConfirmForm>
                        )}
                    </div>
                  </div>
                </div>
              )}
          </div>
          <div
            class="prose dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: bioHtml }}
          />
          {links != null && links.length > 0 && (
            <dl class="mt-5 flex flex-wrap gap-y-3">
              {links.map((link) => (
                <>
                  <dt
                    key={`dt-${link.index}`}
                    class={`
                      opacity-50 mr-1
                      flex flex-row
                      ${link.index > 0 ? "before:content-['·']" : ""}
                    `}
                  >
                    <img
                      src={`/icons/${link.icon}.svg`}
                      alt=""
                      width={20}
                      height={20}
                      class={`dark:invert block mr-1 ${
                        link.index > 0 ? "ml-2" : ""
                      }`}
                    />
                    <span class="block after:content-[':']">{link.name}</span>
                  </dt>
                  <dd key={`dd-${link.index}`} class="mr-2 flex flex-row">
                    <a href={link.url} rel="me">
                      {link.handle ?? compactUrl(link.url)}
                    </a>
                    {link.verified &&
                      (
                        <div title={t("profile.verifiedDescription")}>
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                            className="size-5 ml-1 mt-1"
                            aria-label={t("profile.verified")}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
                            />
                          </svg>
                        </div>
                      )}
                  </dd>
                </>
              ))}
            </dl>
          )}
          {links == null && Object.keys(actor.fieldHtmls).length > 0 && (
            <dl class="mt-5 flex flex-wrap gap-y-3">
              {Object.entries(actor.fieldHtmls).map(([name, html], i) => (
                <>
                  <dt
                    key={`dt-${i}`}
                    class={`
                      opacity-50 mr-1
                      ${i > 0 ? "before:content-['·']" : ""}
                      after:content-[':']
                    `}
                  >
                    <span
                      class={i > 0 ? "ml-2" : ""}
                      dangerouslySetInnerHTML={{
                        __html: renderCustomEmojis(escape(name), actor.emojis),
                      }}
                    />
                  </dt>
                  <dd
                    key={`dd-${i}`}
                    class="mr-2"
                    dangerouslySetInnerHTML={{
                      __html: renderCustomEmojis(
                        sanitizeHtml(html),
                        actor.emojis,
                      ),
                    }}
                  >
                  </dd>
                </>
              ))}
            </dl>
          )}
        </>
      )}
    </Translation>
  );
}

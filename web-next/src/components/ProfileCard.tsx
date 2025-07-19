import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { ProfileCard_account$key } from "./__generated__/ProfileCard_account.graphql.ts";

export interface ProfileCardProps {
  $account: ProfileCard_account$key;
}

export function ProfileCard(props: ProfileCardProps) {
  const { i18n } = useLingui();
  const account = createFragment(
    graphql`
      fragment ProfileCard_account on Account {
        name
        username
        avatarUrl
        actor {
          instanceHost
          bio
          followees {
            totalCount
          }
          followers {
            totalCount
          }
        }
      }
    `,
    () => props.$account,
  );

  return (
    <Show when={account()}>
      {(account) => (
        <>
          <div class="border-b p-4">
            <div class="flex items-center gap-4 mx-auto max-w-prose">
              <Avatar class="size-16">
                <a href={`/@${account().username}`}>
                  <AvatarImage src={account().avatarUrl} class="size-16" />
                </a>
              </Avatar>
              <div>
                <h1 class="text-xl font-semibold">{account().name}</h1>
                <div class="opacity-65">
                  <span class="select-all">
                    @{account().username}@{account().actor.instanceHost}
                  </span>{" "}
                  &middot;{" "}
                  {i18n._(msg`${
                    plural(account().actor.followees.totalCount, {
                      one: "# following",
                      other: "# following",
                    })
                  }`)} &middot;{" "}
                  {i18n._(msg`${
                    plural(account().actor.followers.totalCount, {
                      one: "# follower",
                      other: "# followers",
                    })
                  }`)}
                </div>
              </div>
            </div>
          </div>
          <Show when={(account().actor.bio?.trim() ?? "") !== ""}>
            <div class="p-4 border-b">
              <div
                innerHTML={account().actor.bio ?? ""}
                class="mx-auto prose dark:prose-invert"
              />
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}

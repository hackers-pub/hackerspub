import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
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
        <Card>
          <CardHeader>
            <CardTitle>
              <Avatar>
                <AvatarImage src={account().avatarUrl} />
              </Avatar>
              {account().name}
            </CardTitle>
            <CardDescription>
              @{account().username}@{account().actor.instanceHost} &middot;{" "}
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
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              innerHTML={account().actor.bio ?? ""}
              class="prose dark:prose-invert"
            />
          </CardContent>
        </Card>
      )}
    </Show>
  );
}

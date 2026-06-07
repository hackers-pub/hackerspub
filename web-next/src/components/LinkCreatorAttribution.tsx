import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { cn } from "~/lib/utils.ts";
import type { LinkCreatorAttribution_creator$key } from "./__generated__/LinkCreatorAttribution_creator.graphql.ts";

export interface LinkCreatorAttributionProps {
  $creator: LinkCreatorAttribution_creator$key;
  class?: string;
  labelClass?: string;
}

export function LinkCreatorAttribution(props: LinkCreatorAttributionProps) {
  const { t } = useLingui();
  const creator = createFragment(
    graphql`
      fragment LinkCreatorAttribution_creator on Actor {
        name
        local
        username
        handle
        avatarInitials
        avatarUrl
        url
        iri
      }
    `,
    () => props.$creator,
  );

  const internalHref = (
    c: { local: boolean; username: string; handle: string },
  ) => c.local ? `/@${c.username}` : `/${c.handle}`;

  return (
    <Show keyed when={creator()}>
      {(c) => (
        <div class={cn("flex min-w-0 items-center gap-1.5", props.class)}>
          <span class={cn("shrink-0", props.labelClass)}>
            {t`Link author:`}
          </span>
          <Avatar class="size-6 shrink-0">
            <InternalLink href={c.url ?? c.iri} internalHref={internalHref(c)}>
              <AvatarImage src={c.avatarUrl} class="size-6" />
              <AvatarFallback class="size-6">
                {c.avatarInitials}
              </AvatarFallback>
            </InternalLink>
          </Avatar>
          <div class="min-w-0 break-words">
            <Show when={(c.name ?? "").trim() !== ""}>
              <InternalLink
                href={c.url ?? c.iri}
                internalHref={internalHref(c)}
                innerHTML={c.name ?? ""}
                class="font-semibold hover:underline"
              />
              {" "}
            </Show>
            <span class="select-all text-muted-foreground">
              {c.handle}
            </span>
          </div>
        </div>
      )}
    </Show>
  );
}

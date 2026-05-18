import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface ActorSharerActor {
  name?: string | null;
  local: boolean;
  username: string;
  handle: string;
}

export interface ActorSharerProps {
  actor: ActorSharerActor;
  timestamp: string;
  class?: string;
}

export function ActorSharer(props: ActorSharerProps) {
  const { t } = useLingui();
  return (
    <p class={`text-sm text-muted-foreground ${props.class ?? ""}`}>
      <Trans
        message={t`${"SHARER"} shared ${"RELATIVE_TIME"}`}
        values={{
          SHARER: () => (
            <ActorHoverCard handle={props.actor.handle}>
              <a
                href={`/${
                  props.actor.local
                    ? `@${props.actor.username}`
                    : props.actor.handle
                }`}
                class="font-semibold"
              >
                <span innerHTML={props.actor.name ?? ""} />
              </a>
            </ActorHoverCard>
          ),
          RELATIVE_TIME: () => <Timestamp value={props.timestamp} />,
        }}
      />
    </p>
  );
}

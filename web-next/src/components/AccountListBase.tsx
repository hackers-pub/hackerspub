import { For, Match, Show, Switch } from "solid-js";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

/** The actor fields a row needs; structurally satisfied by the list fragments. */
export interface AccountListItem {
  readonly id: string;
  readonly avatarUrl: string;
  readonly name: string | null | undefined;
  readonly handle: string;
  readonly local: boolean;
  readonly username: string;
}

export interface AccountListBaseProps {
  readonly edges: ReadonlyArray<{ readonly node: AccountListItem }>;
  readonly hasNext: boolean;
  readonly pending: boolean;
  readonly loadingState: "loaded" | "loading" | "errored";
  readonly onLoadMore: () => void;
  /** Invoked with the row actor's global id when its action button is pressed. */
  readonly onAction: (actorId: string) => void;
  readonly actionLabel: string;
  readonly actionDisabled: boolean;
  readonly emptyMessage: string;
}

/**
 * Shared presentation for the muted- and blocked-account management lists: the
 * paginated row layout (avatar, name/handle, an action button) plus the load
 * more control and empty state. Each list owns its own connection fragment and
 * mutation and feeds the resolved edges and handlers in here.
 */
export function AccountListBase(props: AccountListBaseProps) {
  const { t } = useLingui();
  const profileHref = (node: AccountListItem) =>
    `/${node.local ? `@${node.username}` : node.handle}`;
  return (
    <Show
      when={props.edges.length > 0 || props.hasNext}
      fallback={
        <p class="px-4 py-8 text-center text-muted-foreground">
          {props.emptyMessage}
        </p>
      }
    >
      <Show when={props.edges.length > 0}>
        <ul class="divide-y divide-solid">
          <For each={props.edges}>
            {(edge) => (
              <li class="flex items-center gap-3 px-4 py-3">
                <ActorHoverCard handle={edge.node.handle} class="shrink-0">
                  <Avatar class="size-10 shrink-0">
                    <a href={profileHref(edge.node)}>
                      <AvatarImage src={edge.node.avatarUrl} class="size-10" />
                    </a>
                  </Avatar>
                </ActorHoverCard>
                <div class="flex min-w-0 grow flex-col">
                  <Show
                    when={(edge.node.name ?? "").trim() !== ""}
                    fallback={
                      <a
                        href={profileHref(edge.node)}
                        class="truncate font-semibold"
                      >
                        {edge.node.username}
                      </a>
                    }
                  >
                    <a
                      href={profileHref(edge.node)}
                      innerHTML={edge.node.name ?? ""}
                      class="truncate font-semibold"
                    />
                  </Show>
                  <span
                    class="truncate text-sm text-muted-foreground select-all"
                    title={edge.node.handle}
                  >
                    {edge.node.handle}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  disabled={props.actionDisabled}
                  onClick={() => props.onAction(edge.node.id)}
                >
                  {props.actionLabel}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.hasNext}>
        <button
          type="button"
          onClick={props.onLoadMore}
          disabled={props.pending || props.loadingState === "loading"}
          class="block w-full cursor-pointer px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={props.pending || props.loadingState === "loading"}>
              {t`Loading more…`}
            </Match>
            <Match when={props.loadingState === "errored"}>
              {t`Failed to load more; click to retry`}
            </Match>
            <Match when={props.loadingState === "loaded"}>
              {t`Load more`}
            </Match>
          </Switch>
        </button>
      </Show>
    </Show>
  );
}

import { type Uuid } from "@hackerspub/models/uuid";
import { createSignal, For, Show } from "solid-js";
import { AppealDialog } from "~/components/AppealDialog.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

interface SanctionAppeal {
  status: string;
  result: string | null | undefined;
  reviewRationale: string | null | undefined;
}

interface Sanction {
  uuid: Uuid;
  actionType: string;
  violatedProvisions: readonly string[];
  messageToUser: string | null | undefined;
  suspensionEnds: string | null | undefined;
  created: string;
  appealableUntil: string;
  appeal: SanctionAppeal | null | undefined;
}

export interface SanctionHistoryListProps {
  sanctions: readonly Sanction[] | null | undefined;
  onAppealSuccess: () => void;
}

export function SanctionHistoryList(props: SanctionHistoryListProps) {
  const { t } = useLingui();
  const [appealTarget, setAppealTarget] = createSignal<Uuid | null>(null);

  const actionLabel = (type: string) => {
    switch (type) {
      case "WARNING":
        return t`Warning`;
      case "CENSOR":
        return t`Post hidden`;
      case "SUSPEND":
        return t`Account suspended`;
      case "BAN":
        return t`Account permanently suspended`;
      case "DISMISS":
        return t`Report dismissed`;
      default:
        return type;
    }
  };

  const appealStatusLabel = (status: string, result: string | null) => {
    if (status !== "RESOLVED") {
      return status === "REVIEWING"
        ? t`Appeal under review`
        : t`Appeal pending`;
    }
    switch (result) {
      case "WITHDRAWN":
        return t`Appeal upheld: the decision was withdrawn`;
      case "REDUCED":
        return t`Appeal upheld: the sanction was reduced`;
      case "INCREASED":
        return t`Appeal reviewed: the sanction was increased`;
      default:
        return t`Appeal denied: the decision stands`;
    }
  };

  return (
    <>
      <Show
        when={(props.sanctions?.length ?? 0) > 0}
        fallback={
          <p class="px-4 py-8 text-center text-muted-foreground">
            {t`There are no moderation actions on your account.`}
          </p>
        }
      >
        <ul class="divide-y divide-solid">
          <For each={props.sanctions ?? []}>
            {(sanction) => {
              // A dismissal carries no sanction to appeal (it may still appear
              // here when the moderator left a message); the server rejects
              // appeals on it.
              const canAppeal = sanction.appeal == null &&
                sanction.actionType !== "DISMISS" &&
                new Date(sanction.appealableUntil) > new Date();
              return (
                <li class="flex flex-col gap-2 px-4 py-4">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge>{actionLabel(sanction.actionType)}</Badge>
                    <span class="text-xs text-muted-foreground">
                      <Timestamp
                        value={sanction.created}
                        capitalizeFirstLetter
                      />
                    </span>
                  </div>
                  <Show when={sanction.violatedProvisions.length > 0}>
                    <p class="text-sm text-muted-foreground">
                      {t`Code of conduct: ${
                        sanction.violatedProvisions.join(", ")
                      }`}
                    </p>
                  </Show>
                  <Show keyed when={sanction.messageToUser}>
                    {(message) => (
                      <div class="rounded-md border bg-muted/40 p-3 text-sm">
                        <p class="whitespace-pre-wrap break-words">
                          {message}
                        </p>
                      </div>
                    )}
                  </Show>
                  <Show keyed when={sanction.suspensionEnds}>
                    {(ends) => (
                      <p class="text-xs text-muted-foreground">
                        {t`Suspension ends`}{" "}
                        <Timestamp value={ends} allowFuture />
                      </p>
                    )}
                  </Show>
                  <div class="mt-1 flex flex-wrap items-center gap-3">
                    <Show
                      when={sanction.appeal}
                      fallback={
                        <Show
                          when={canAppeal}
                          fallback={
                            <span class="text-xs text-muted-foreground">
                              {t`The appeal window has closed.`}
                            </span>
                          }
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setAppealTarget(sanction.uuid)}
                          >
                            {t`Appeal this decision`}
                          </Button>
                        </Show>
                      }
                    >
                      {(appeal) => (
                        <div class="flex flex-col gap-1">
                          <Badge
                            variant={appeal().status === "RESOLVED"
                              ? "secondary"
                              : "warning"}
                          >
                            {appealStatusLabel(
                              appeal().status,
                              appeal().result ?? null,
                            )}
                          </Badge>
                          <Show keyed when={appeal().reviewRationale}>
                            {(rationale) => (
                              <p class="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                                {rationale}
                              </p>
                            )}
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show keyed when={appealTarget()}>
        {(sanctionId) => (
          <AppealDialog
            open
            onOpenChange={(open) => {
              if (!open) setAppealTarget(null);
            }}
            sanctionId={sanctionId}
            onSuccess={props.onAppealSuccess}
          />
        )}
      </Show>
    </>
  );
}

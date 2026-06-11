import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AppealDialog } from "~/components/AppealDialog.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { sanctionsPageQuery } from "./__generated__/sanctionsPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const sanctionsPageQuery = graphql`
  query sanctionsPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      sanctions {
        uuid
        actionType
        violatedProvisions
        messageToUser
        suspensionEnds
        created
        appealableUntil
        appeal {
          status
          result
          reviewRationale
          resolved
        }
      }
    }
  }
`;

const loadSanctionsPageQuery = routePreloadedQuery(
  (handle: string, _version: number) =>
    loadQuery<sanctionsPageQuery>(
      useRelayEnvironment()(),
      sanctionsPageQuery,
      { username: handle.replace(/^@/, "") },
      { fetchPolicy: "network-only" },
    ),
  "loadSanctionsPageQuery",
);

export default function SanctionsPage() {
  const params = useParams();
  const { t } = useLingui();
  const [version, setVersion] = createSignal(0);

  const data = createStablePreloadedQuery<sanctionsPageQuery>(
    sanctionsPageQuery,
    () => loadSanctionsPageQuery(decodeRouteParam(params.handle!), version()),
  );

  const [appealTarget, setAppealTarget] = createSignal<string | null>(null);

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
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          viewerId={data.viewer?.id}
        >
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Sanctions`}</Title>
                <NarrowContainer class="p-4">
                  <SettingsTabs selected="sanctions" $account={account} />
                  <div class="mt-4 flex flex-col gap-4">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Moderation actions`}</CardTitle>
                        <CardDescription>
                          {t`Decisions the moderation team has made about your account or posts, newest first. You can appeal a decision once, within 14 days.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="px-0">
                        <Show
                          when={(account.sanctions?.length ?? 0) > 0}
                          fallback={
                            <p class="px-4 py-8 text-center text-muted-foreground">
                              {t`There are no moderation actions on your account.`}
                            </p>
                          }
                        >
                          <ul class="divide-y divide-solid">
                            <For each={account.sanctions ?? []}>
                              {(sanction) => {
                                const canAppeal = sanction.appeal == null &&
                                  new Date(sanction.appealableUntil) >
                                    new Date();
                                return (
                                  <li class="flex flex-col gap-2 px-4 py-4">
                                    <div class="flex flex-wrap items-center gap-2">
                                      <Badge>
                                        {actionLabel(sanction.actionType)}
                                      </Badge>
                                      <span class="text-xs text-muted-foreground">
                                        <Timestamp
                                          value={sanction.created}
                                          capitalizeFirstLetter
                                        />
                                      </span>
                                    </div>
                                    <Show
                                      when={sanction.violatedProvisions.length >
                                        0}
                                    >
                                      <p class="text-sm text-muted-foreground">
                                        {t`Code of conduct: ${
                                          sanction
                                            .violatedProvisions.join(", ")
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
                                              onClick={() =>
                                                setAppealTarget(sanction.uuid)}
                                            >
                                              {t`Appeal this decision`}
                                            </Button>
                                          </Show>
                                        }
                                      >
                                        {(appeal) => (
                                          <div class="flex flex-col gap-1">
                                            <Badge
                                              variant={appeal().status ===
                                                  "RESOLVED"
                                                ? "secondary"
                                                : "warning"}
                                            >
                                              {appealStatusLabel(
                                                appeal().status,
                                                appeal().result ?? null,
                                              )}
                                            </Badge>
                                            <Show
                                              keyed
                                              when={appeal().reviewRationale}
                                            >
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
                      </CardContent>
                    </Card>
                  </div>
                </NarrowContainer>
                <Show keyed when={appealTarget()}>
                  {(sanctionId) => (
                    <AppealDialog
                      open
                      onOpenChange={(open) => {
                        if (!open) setAppealTarget(null);
                      }}
                      sanctionId={sanctionId}
                      onSuccess={() => setVersion((v) => v + 1)}
                    />
                  )}
                </Show>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}

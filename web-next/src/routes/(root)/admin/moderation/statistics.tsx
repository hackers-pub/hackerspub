import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { ModerationSubTabs } from "~/components/admin/ModerationSubTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { statisticsPageQuery } from "./__generated__/statisticsPageQuery.graphql.ts";

const statisticsPageQuery = graphql`
  query statisticsPageQuery {
    viewer {
      moderator
    }
    moderationStatistics {
      totalReports
      processedReports
      averageProcessingHours
      actionDistribution {
        actionType
        count
      }
      topViolatedProvisions {
        provision
        count
      }
      llmDivergence {
        compared
        diverged
      }
    }
  }
`;

const loadStatisticsPageQuery = routePreloadedQuery(
  () =>
    loadQuery<statisticsPageQuery>(
      useRelayEnvironment()(),
      statisticsPageQuery,
      {},
    ),
  "loadStatisticsPageQuery",
);

export default function ModerationStatisticsPage() {
  const { t, i18n } = useLingui();
  const data = createStablePreloadedQuery<statisticsPageQuery>(
    statisticsPageQuery,
    () => loadStatisticsPageQuery(),
  );

  const num = (n: number) => n.toLocaleString(i18n.locale);
  const pct = (n: number, d: number) =>
    d < 1 ? "—" : `${Math.round((n / d) * 100)}%`;

  const actionLabel = (type: string) => {
    switch (type) {
      case "DISMISS":
        return t`Dismissed`;
      case "WARNING":
        return t`Warning`;
      case "CENSOR":
        return t`Post censored`;
      case "SUSPEND":
        return t`Suspended`;
      case "BAN":
        return t`Banned`;
      default:
        return type;
    }
  };

  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Moderation statistics`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Fmoderation" />}
          >
            <AdminTabs selected="moderation" />
            <ModerationSubTabs selected="statistics" />
            <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
              {t`Statistics`}
            </h1>

            <Show keyed when={data.moderationStatistics}>
              {(stats) => {
                const maxAction = Math.max(
                  1,
                  ...stats.actionDistribution.map((a) => a.count),
                );
                const maxProvision = Math.max(
                  1,
                  ...stats.topViolatedProvisions.map((p) => p.count),
                );
                return (
                  <div class="flex flex-col gap-6">
                    {/* Headline numbers */}
                    <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <Card>
                        <CardHeader class="pb-2">
                          <CardTitle class="text-sm font-medium text-muted-foreground">
                            {t`Total reports`}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p class="text-2xl font-semibold tabular-nums">
                            {num(stats.totalReports)}
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader class="pb-2">
                          <CardTitle class="text-sm font-medium text-muted-foreground">
                            {t`Processed`}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p class="text-2xl font-semibold tabular-nums">
                            {num(stats.processedReports)}
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader class="pb-2">
                          <CardTitle class="text-sm font-medium text-muted-foreground">
                            {t`Processing rate`}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p class="text-2xl font-semibold tabular-nums">
                            {pct(stats.processedReports, stats.totalReports)}
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader class="pb-2">
                          <CardTitle class="text-sm font-medium text-muted-foreground">
                            {t`Avg. processing time`}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p class="text-2xl font-semibold tabular-nums">
                            <Show
                              when={stats.averageProcessingHours != null}
                              fallback="—"
                            >
                              {t`${Math.round(
                                stats.averageProcessingHours!,
                              )} h`}
                            </Show>
                          </p>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Action distribution */}
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Action distribution`}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Show
                          when={stats.actionDistribution.length > 0}
                          fallback={
                            <p class="text-sm text-muted-foreground">
                              {t`No actions have been taken yet.`}
                            </p>
                          }
                        >
                          <ul class="flex flex-col gap-2">
                            <For each={stats.actionDistribution}>
                              {(entry) => (
                                <li class="flex items-center gap-3 text-sm">
                                  <span class="w-28 shrink-0">
                                    {actionLabel(entry.actionType)}
                                  </span>
                                  <div class="h-2 grow overflow-hidden rounded-full bg-muted">
                                    <div
                                      class="h-full rounded-full bg-primary"
                                      style={{
                                        width: `${
                                          (entry.count / maxAction) * 100
                                        }%`,
                                      }}
                                    />
                                  </div>
                                  <span class="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                                    {num(entry.count)}
                                  </span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </CardContent>
                    </Card>

                    {/* Top violated provisions */}
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Most-cited provisions`}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Show
                          when={stats.topViolatedProvisions.length > 0}
                          fallback={
                            <p class="text-sm text-muted-foreground">
                              {t`No provisions have been cited yet.`}
                            </p>
                          }
                        >
                          <ul class="flex flex-col gap-2">
                            <For each={stats.topViolatedProvisions}>
                              {(entry) => (
                                <li class="flex items-center gap-3 text-sm">
                                  <span class="w-16 shrink-0 font-semibold">
                                    {entry.provision}
                                  </span>
                                  <div class="h-2 grow overflow-hidden rounded-full bg-muted">
                                    <div
                                      class="h-full rounded-full bg-primary"
                                      style={{
                                        width: `${
                                          (entry.count / maxProvision) * 100
                                        }%`,
                                      }}
                                    />
                                  </div>
                                  <span class="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                                    {num(entry.count)}
                                  </span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </CardContent>
                    </Card>

                    {/* LLM divergence */}
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`LLM matching divergence`}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Show
                          keyed
                          when={stats.llmDivergence}
                          fallback={
                            <p class="text-sm text-muted-foreground">
                              {t`No analyzed reports have been processed yet.`}
                            </p>
                          }
                        >
                          {(divergence) => (
                            <div class="flex flex-col gap-2">
                              <p class="text-2xl font-semibold tabular-nums">
                                {pct(divergence.diverged, divergence.compared)}
                              </p>
                              <p class="text-sm text-muted-foreground">
                                {t`${num(divergence.diverged)} of ${num(
                                  divergence.compared,
                                )} analyzed reports diverged from the moderators' confirmed provisions. Very high or near-zero divergence both warrant attention.`}
                              </p>
                            </div>
                          )}
                        </Show>
                      </CardContent>
                    </Card>
                  </div>
                );
              }}
            </Show>
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}

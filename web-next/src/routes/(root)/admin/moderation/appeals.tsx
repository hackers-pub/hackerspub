import { A, Navigate, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import IconTriangleAlert from "~icons/lucide/triangle-alert";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { AppealResolveForm } from "~/components/admin/AppealResolveForm.tsx";
import { ModerationSubTabs } from "~/components/admin/ModerationSubTabs.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
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
import type {
  appealsPageQuery,
  FlagAppealStatus,
} from "./__generated__/appealsPageQuery.graphql.ts";

const appealsPageQuery = graphql`
  query appealsPageQuery($status: FlagAppealStatus, $locale: Locale) {
    viewer {
      id
      moderator
    }
    moderationAppeals(first: 50, status: $status) {
      edges {
        node {
          id
          status
          result
          reason
          additionalContext
          reviewRationale
          created
          appellant {
            username
            name
            handle
          }
          action {
            actionType
            violatedProvisions
            rationale
            created
            moderator {
              id
              username
              name
            }
            case {
              targetPostIri
              targetPost {
                id
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    codeOfConductProvisions(locale: $locale) {
      id
      section
      title
      text
    }
  }
`;

const STATUS_VALUES = ["PENDING", "REVIEWING", "RESOLVED"] as const;

function parseStatus(raw: string | null): FlagAppealStatus | null {
  const upper = raw?.toUpperCase() ?? "";
  return (STATUS_VALUES as readonly string[]).includes(upper)
    ? (upper as FlagAppealStatus)
    : null;
}

const loadAppealsPageQuery = routePreloadedQuery(
  (status: FlagAppealStatus | null, locale: string, _version: number) =>
    loadQuery<appealsPageQuery>(
      useRelayEnvironment()(),
      appealsPageQuery,
      { status, locale },
      { fetchPolicy: "network-only" },
    ),
  "loadAppealsPageQuery",
);

export default function ModerationAppealsPage() {
  const { t, i18n } = useLingui();
  const location = useLocation();
  const [version, setVersion] = createSignal(0);
  const status = createMemo(() =>
    parseStatus(new URLSearchParams(location.search).get("status")),
  );

  const data = createStablePreloadedQuery<appealsPageQuery>(
    appealsPageQuery,
    () => loadAppealsPageQuery(status(), i18n.locale, version()),
  );

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

  const resultLabel = (result: string) => {
    switch (result) {
      case "DISMISSED":
        return t`Denied`;
      case "WITHDRAWN":
        return t`Withdrawn`;
      case "REDUCED":
        return t`Reduced`;
      case "INCREASED":
        return t`Increased`;
      default:
        return result;
    }
  };

  function statusHref(value: FlagAppealStatus | null): string {
    const params = new URLSearchParams(location.search);
    if (value) params.set("status", value);
    else params.delete("status");
    const qs = params.toString();
    return qs ? `${location.pathname}?${qs}` : location.pathname;
  }

  const statusFilters: { value: FlagAppealStatus | null; label: string }[] = [
    { value: null, label: t`All` },
    { value: "PENDING", label: t`Pending` },
    { value: "RESOLVED", label: t`Resolved` },
  ];

  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Appeals`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Fmoderation" />}
          >
            <AdminTabs selected="moderation" />
            <ModerationSubTabs selected="appeals" />
            <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
              {t`Appeals`}
            </h1>

            <div class="mb-4 flex flex-wrap items-center gap-2">
              <For each={statusFilters}>
                {(item) => (
                  <Button
                    as={A}
                    href={statusHref(item.value)}
                    variant={status() === item.value ? "default" : "outline"}
                    size="sm"
                  >
                    {item.label}
                  </Button>
                )}
              </For>
            </div>

            <Show
              when={(data.moderationAppeals?.edges?.length ?? 0) > 0}
              fallback={
                <p class="px-4 py-12 text-center text-muted-foreground">
                  {t`No appeals match these filters.`}
                </p>
              }
            >
              <div class="flex flex-col gap-4">
                <For each={data.moderationAppeals?.edges ?? []}>
                  {(edge) => {
                    const appeal = edge.node;
                    const open = appeal.status !== "RESOLVED";
                    const sameModerator =
                      appeal.action.moderator?.id === data.viewer?.id;
                    const canCensor = appeal.action.case.targetPost != null;
                    return (
                      <Card>
                        <CardHeader>
                          <CardTitle class="flex flex-wrap items-center gap-2 text-base">
                            <a
                              href={`/@${appeal.appellant.username}`}
                              class="hover:underline"
                            >
                              {appeal.appellant.name ??
                                appeal.appellant.username}
                            </a>
                            <span class="text-sm font-normal text-muted-foreground">
                              {appeal.appellant.handle}
                            </span>
                            <Badge variant={open ? "warning" : "secondary"}>
                              <Show when={appeal.result} fallback={t`Pending`}>
                                {resultLabel(appeal.result!)}
                              </Show>
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent class="flex flex-col gap-4">
                          {/* Appealed decision */}
                          <div class="rounded-md border p-3">
                            <div class="mb-1 flex flex-wrap items-center gap-2">
                              <span class="text-xs font-medium text-muted-foreground">
                                {t`Appealed decision`}:
                              </span>
                              <Badge variant="outline">
                                {actionLabel(appeal.action.actionType)}
                              </Badge>
                              <span class="text-xs text-muted-foreground">
                                {appeal.action.violatedProvisions.join(", ")}
                              </span>
                            </div>
                            <p class="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                              {appeal.action.rationale}
                            </p>
                          </div>

                          {/* Appeal reason */}
                          <div>
                            <p class="mb-1 text-xs font-medium text-muted-foreground">
                              {t`Appeal`}
                            </p>
                            <p class="text-sm whitespace-pre-wrap break-words">
                              {appeal.reason}
                            </p>
                            <Show keyed when={appeal.additionalContext}>
                              {(context) => (
                                <p class="mt-2 text-sm text-muted-foreground whitespace-pre-wrap break-words">
                                  {context}
                                </p>
                              )}
                            </Show>
                            <p class="mt-1 text-xs text-muted-foreground">
                              <Timestamp value={appeal.created} />
                            </p>
                          </div>

                          <Show when={open && sameModerator}>
                            <div class="flex items-start gap-2 rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground">
                              <IconTriangleAlert
                                class="mt-0.5 size-4 shrink-0"
                                aria-hidden="true"
                              />
                              <p>
                                {t`You took the original action. Consider letting another moderator review this appeal.`}
                              </p>
                            </div>
                          </Show>

                          <Show
                            when={open}
                            fallback={
                              <Show keyed when={appeal.reviewRationale}>
                                {(rationale) => (
                                  <div class="rounded-md bg-muted/50 p-3 text-sm">
                                    <p class="mb-1 text-xs font-medium text-muted-foreground">
                                      {t`Review outcome`}
                                    </p>
                                    <p class="whitespace-pre-wrap break-words">
                                      {rationale}
                                    </p>
                                  </div>
                                )}
                              </Show>
                            }
                          >
                            <AppealResolveForm
                              appealId={appeal.id}
                              provisions={data.codeOfConductProvisions ?? []}
                              canCensor={canCensor}
                              onResolved={() => setVersion((v) => v + 1)}
                            />
                          </Show>
                        </CardContent>
                      </Card>
                    );
                  }}
                </For>
                <Show when={data.moderationAppeals?.pageInfo.hasNextPage}>
                  <p class="text-center text-xs text-muted-foreground">
                    {t`Showing the 50 most recent appeals. Resolve some to see older ones.`}
                  </p>
                </Show>
              </div>
            </Show>
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}

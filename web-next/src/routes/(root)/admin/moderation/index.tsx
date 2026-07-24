import { A, Navigate, useLocation, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import IconSearch from "~icons/lucide/search";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import {
  HIGH_PRIORITY_REPORT_COUNT,
  ModerationCaseList,
} from "~/components/admin/ModerationCaseList.tsx";
import { ModerationSubTabs } from "~/components/admin/ModerationSubTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type {
  FlagStatus,
  moderationCasesPageQuery,
} from "./__generated__/moderationCasesPageQuery.graphql.ts";

const moderationCasesPageQuery = graphql`
  query moderationCasesPageQuery(
    $status: FlagStatus
    $minReportCount: Int
    $search: String
  ) {
    viewer {
      moderator
    }
    ...ModerationCaseList_query
      @arguments(
        status: $status
        minReportCount: $minReportCount
        search: $search
      )
  }
`;

const STATUS_VALUES = [
  "PENDING",
  "REVIEWING",
  "RESOLVED",
  "DISMISSED",
] as const;

function parseStatus(raw: string | null): FlagStatus | null {
  const upper = raw?.toUpperCase() ?? "";
  return (STATUS_VALUES as readonly string[]).includes(upper)
    ? (upper as FlagStatus)
    : null;
}

interface Filters {
  status: FlagStatus | null;
  minReportCount: number | null;
  search: string | undefined;
}

function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  return {
    status: parseStatus(params.get("status")),
    minReportCount:
      params.get("priority") === "1" ? HIGH_PRIORITY_REPORT_COUNT : null,
    search: params.get("q")?.trim() || undefined,
  };
}

const loadModerationCasesPageQuery = routePreloadedQuery(
  (filters: Filters) =>
    loadQuery<moderationCasesPageQuery>(
      useRelayEnvironment()(),
      moderationCasesPageQuery,
      {
        status: filters.status,
        minReportCount: filters.minReportCount,
        search: filters.search,
      },
    ),
  "loadModerationCasesPageQuery",
);

export default function ModerationCasesPage() {
  const { t } = useLingui();
  const location = useLocation();
  const navigate = useNavigate();
  const filters = createMemo(() => parseFilters(location.search));

  const data = createStablePreloadedQuery<moderationCasesPageQuery>(
    moderationCasesPageQuery,
    () => loadModerationCasesPageQuery(filters()),
  );

  const [searchInput, setSearchInput] = createSignal(filters().search ?? "");
  createEffect(() => setSearchInput(filters().search ?? ""));

  function buildHref(overrides: {
    status?: string | null;
    priority?: boolean;
    q?: string;
  }): string {
    const params = new URLSearchParams(location.search);
    if ("status" in overrides) {
      if (overrides.status) params.set("status", overrides.status);
      else params.delete("status");
    }
    if ("priority" in overrides) {
      if (overrides.priority) params.set("priority", "1");
      else params.delete("priority");
    }
    if ("q" in overrides) {
      if (overrides.q?.trim()) params.set("q", overrides.q.trim());
      else params.delete("q");
    }
    const qs = params.toString();
    return qs ? `${location.pathname}?${qs}` : location.pathname;
  }

  const statusFilters: { value: FlagStatus | null; label: string }[] = [
    { value: null, label: t`All` },
    { value: "PENDING", label: t`Pending` },
    { value: "REVIEWING", label: t`Reviewing` },
    { value: "RESOLVED", label: t`Resolved` },
    { value: "DISMISSED", label: t`Dismissed` },
  ];

  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Moderation`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Fmoderation" />}
          >
            <AdminTabs selected="moderation" />
            <ModerationSubTabs selected="cases" />
            <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
              {t`Moderation cases`}
            </h1>

            <div class="mb-4 flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <For each={statusFilters}>
                  {(item) => (
                    <Button
                      as={A}
                      href={buildHref({ status: item.value })}
                      variant={
                        filters().status === item.value ? "default" : "outline"
                      }
                      size="sm"
                    >
                      {item.label}
                    </Button>
                  )}
                </For>
                <Button
                  as={A}
                  href={buildHref({
                    priority: filters().minReportCount == null,
                  })}
                  variant={
                    filters().minReportCount != null ? "default" : "outline"
                  }
                  size="sm"
                >
                  {t`${HIGH_PRIORITY_REPORT_COUNT}+ reports`}
                </Button>
              </div>
              <form
                class="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(buildHref({ q: searchInput() }));
                }}
              >
                <div class="relative grow">
                  <IconSearch class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={searchInput()}
                    onInput={(e) => setSearchInput(e.currentTarget.value)}
                    placeholder={t`Search by handle or display name`}
                    class="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
                <Button type="submit" variant="outline" size="sm">
                  {t`Search`}
                </Button>
              </form>
            </div>

            <ModerationCaseList $query={data} />
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}

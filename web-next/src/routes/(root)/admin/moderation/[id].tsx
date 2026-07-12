import {
  A,
  Navigate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { type Uuid } from "@hackerspub/models/uuid";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconSparkles from "~icons/lucide/sparkles";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { ModerationActionForm } from "~/components/admin/ModerationActionForm.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { IdCaseDetailQuery } from "./__generated__/IdCaseDetailQuery.graphql.ts";

export const route = {
  matchFilters: {
    id: /^[0-9a-f-]{36}$/i,
  },
} satisfies RouteDefinition;

const IdCaseDetailQuery = graphql`
  query IdCaseDetailQuery($uuid: UUID!, $locale: Locale) {
    viewer {
      moderator
    }
    flagCaseByUuid(uuid: $uuid) {
      id
      uuid
      status
      reportCount
      forwardingEnabled
      targetPostIri
      targetPost {
        id
      }
      targetActor {
        name
        handle
        username
        local
        avatarUrl
        avatarInitials
        suspended
      }
      flags(first: 50) {
        edges {
          node {
            id
            reason
            created
            external
            llmAnalysis
            reporter {
              handle
            }
            snapshot {
              contentHtml
            }
          }
        }
      }
      actions {
        id
        actionType
        violatedProvisions
        rationale
        messageToUser
        suspensionEnds
        created
      }
      violationHistory {
        id
        actionType
        violatedProvisions
        created
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

const loadCaseDetailQuery = routePreloadedQuery(
  (uuid: Uuid, locale: string) =>
    loadQuery<IdCaseDetailQuery>(
      useRelayEnvironment()(),
      IdCaseDetailQuery,
      { uuid, locale },
    ),
  "loadCaseDetailQuery",
);

interface LlmAnalysis {
  matches?: { provision: string; confidence: number; rationale: string }[];
  summary?: string;
  model?: string;
  analyzed?: string;
  error?: string;
}

export default function ModerationCaseDetailPage() {
  const { t, i18n } = useLingui();
  const params = useParams();
  const navigate = useNavigate();

  const actionTypeLabel = (type: string) => {
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

  const data = createStablePreloadedQuery<IdCaseDetailQuery>(
    IdCaseDetailQuery,
    () => loadCaseDetailQuery(params.id! as Uuid, i18n.locale),
  );

  const profileHref = (
    actor: { local: boolean; username: string; handle: string },
  ) => `/${actor.local ? `@${actor.username}` : actor.handle}`;

  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Moderation case`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Fmoderation" />}
          >
            <AdminTabs selected="moderation" />
            <A
              href="/admin/moderation"
              class="mt-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <IconArrowLeft class="size-4" />
              {t`Back to cases`}
            </A>

            <Show
              keyed
              when={data.flagCaseByUuid}
              fallback={
                <p class="mt-8 text-center text-muted-foreground">
                  {t`This case does not exist.`}
                </p>
              }
            >
              {(flagCase) => {
                const isOpen = () =>
                  flagCase.status === "PENDING" ||
                  flagCase.status === "REVIEWING";
                const postReport = flagCase.targetPostIri != null;
                const canCensor = flagCase.targetPost != null;
                // `violationHistory` is the target's standing history across
                // all cases; on a resolved case it includes the action just
                // taken here, so drop actions already shown under Decisions.
                const ownActionIds = new Set(
                  (flagCase.actions ?? []).map((action) => action.id),
                );
                const priorViolations = () =>
                  (flagCase.violationHistory ?? []).filter(
                    (action) => !ownActionIds.has(action.id),
                  );
                return (
                  <div class="mt-4 flex flex-col gap-6">
                    {/* Target header */}
                    <div class="flex items-center gap-3">
                      <Avatar class="size-12 shrink-0">
                        <a href={profileHref(flagCase.targetActor)}>
                          <AvatarImage
                            src={flagCase.targetActor.avatarUrl}
                            class="size-12"
                          />
                          <AvatarFallback class="size-12">
                            {flagCase.targetActor.avatarInitials}
                          </AvatarFallback>
                        </a>
                      </Avatar>
                      <div class="flex min-w-0 grow flex-col">
                        <Show
                          when={(flagCase.targetActor.name ?? "").trim() !== ""}
                          fallback={
                            <a
                              href={profileHref(flagCase.targetActor)}
                              class="truncate text-lg font-semibold hover:underline"
                            >
                              {flagCase.targetActor.username}
                            </a>
                          }
                        >
                          <a
                            href={profileHref(flagCase.targetActor)}
                            class="truncate text-lg font-semibold hover:underline"
                            innerHTML={flagCase.targetActor.name ?? ""}
                          />
                        </Show>
                        <span class="truncate text-sm text-muted-foreground">
                          {flagCase.targetActor.handle}
                        </span>
                      </div>
                      <div class="flex shrink-0 flex-col items-end gap-1.5">
                        <Badge variant={isOpen() ? "secondary" : "outline"}>
                          {flagCase.status}
                        </Badge>
                        <Show when={flagCase.targetActor.suspended}>
                          <Badge variant="error">{t`Suspended`}</Badge>
                        </Show>
                      </div>
                    </div>

                    {/* Reports */}
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          <Show
                            when={flagCase.reportCount === 1}
                            fallback={t`${flagCase.reportCount} reports`}
                          >
                            {t`1 report`}
                          </Show>
                        </CardTitle>
                        <CardDescription>
                          <Show
                            when={postReport}
                            fallback={t`A user (profile) report.`}
                          >
                            {t`A content (post) report.`}
                          </Show>
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="flex flex-col gap-4">
                        <For each={flagCase.flags?.edges ?? []}>
                          {(edge) => {
                            const flag = edge.node;
                            const analysis = flag
                              .llmAnalysis as LlmAnalysis | null;
                            return (
                              <div class="rounded-md border p-3">
                                <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                  <Timestamp
                                    value={flag.created}
                                    capitalizeFirstLetter
                                  />
                                  <Show when={flag.reporter}>
                                    {(reporter) => (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span>
                                          {t`by ${reporter().handle}`}
                                        </span>
                                      </>
                                    )}
                                  </Show>
                                  <Show when={flag.external}>
                                    <Badge variant="outline">
                                      {t`External`}
                                    </Badge>
                                  </Show>
                                </div>
                                <p class="whitespace-pre-wrap break-words text-sm">
                                  {flag.reason}
                                </p>
                                <Show when={analysis}>
                                  {(analysis) => (
                                    <LlmAnalysisPanel analysis={analysis()} />
                                  )}
                                </Show>
                                <Show keyed when={flag.snapshot}>
                                  {(snapshot) => (
                                    <details class="mt-3 text-sm">
                                      <summary class="cursor-pointer text-muted-foreground">
                                        {t`Snapshot at report time`}
                                      </summary>
                                      <div
                                        class="prose dark:prose-invert mt-2 max-w-none rounded-md border bg-muted/40 p-3"
                                        innerHTML={snapshot.contentHtml}
                                      />
                                    </details>
                                  )}
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </CardContent>
                    </Card>

                    {/* Violation history */}
                    <Show when={priorViolations().length > 0}>
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Prior violations`}</CardTitle>
                          <CardDescription>
                            {t`The target's standing moderation history; accumulated history affects sanction levels.`}
                          </CardDescription>
                        </CardHeader>
                        <CardContent class="flex flex-col gap-2">
                          <For each={priorViolations()}>
                            {(action) => (
                              <div class="flex flex-wrap items-center gap-2 text-sm">
                                <Badge variant="outline">
                                  {actionTypeLabel(action.actionType)}
                                </Badge>
                                <span class="text-muted-foreground">
                                  {action.violatedProvisions.join(", ")}
                                </span>
                                <span class="text-xs text-muted-foreground">
                                  <Timestamp value={action.created} />
                                </span>
                              </div>
                            )}
                          </For>
                        </CardContent>
                      </Card>
                    </Show>

                    {/* Actions already taken */}
                    <Show when={(flagCase.actions?.length ?? 0) > 0}>
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Decisions`}</CardTitle>
                        </CardHeader>
                        <CardContent class="flex flex-col gap-3">
                          <For each={flagCase.actions ?? []}>
                            {(action) => (
                              <div class="rounded-md border p-3">
                                <div class="mb-1 flex flex-wrap items-center gap-2">
                                  <Badge>
                                    {actionTypeLabel(action.actionType)}
                                  </Badge>
                                  <span class="text-xs text-muted-foreground">
                                    <Timestamp value={action.created} />
                                  </span>
                                </div>
                                <Show
                                  when={action.violatedProvisions.length > 0}
                                >
                                  <p class="text-sm text-muted-foreground">
                                    {action.violatedProvisions.join(", ")}
                                  </p>
                                </Show>
                                <p class="mt-1 whitespace-pre-wrap break-words text-sm">
                                  {action.rationale}
                                </p>
                                <Show keyed when={action.messageToUser}>
                                  {(message) => (
                                    <div class="mt-2 rounded-md bg-muted/50 p-2 text-sm">
                                      <span class="text-xs font-medium text-muted-foreground">
                                        {t`Shown to the user`}:
                                      </span>
                                      <p class="whitespace-pre-wrap break-words">
                                        {message}
                                      </p>
                                    </div>
                                  )}
                                </Show>
                                <Show
                                  keyed
                                  when={action.suspensionEnds}
                                >
                                  {(ends) => (
                                    <p class="mt-1 text-xs text-muted-foreground">
                                      {t`Suspension ends`}{" "}
                                      <Timestamp value={ends} allowFuture />
                                    </p>
                                  )}
                                </Show>
                              </div>
                            )}
                          </For>
                        </CardContent>
                      </Card>
                    </Show>

                    {/* Action form (open cases only) */}
                    <Show
                      when={isOpen()}
                      fallback={
                        <p class="text-center text-sm text-muted-foreground">
                          {t`This case is resolved.`}
                        </p>
                      }
                    >
                      <Card>
                        <CardHeader>
                          <CardTitle>{t`Take action`}</CardTitle>
                          <CardDescription>
                            <Show
                              when={flagCase.targetActor.local}
                              fallback={t`This is a remote actor with no local notification or appeal. A warning is only recorded, censoring hides the locally cached post, and a suspension or ban applies a temporary or permanent federation block. A summary may be forwarded to their instance if a reporter opted in.`}
                            >
                              {t`A local sanction notifies the reported user under the moderation team's collective identity, and they can appeal within 14 days. A dismissal notifies them only if you add a message.`}
                            </Show>
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <ModerationActionForm
                            caseId={flagCase.id}
                            provisions={data.codeOfConductProvisions ?? []}
                            canCensor={canCensor}
                            forwardingEnabled={flagCase.forwardingEnabled}
                            local={flagCase.targetActor.local}
                            onActioned={() => navigate("/admin/moderation")}
                          />
                        </CardContent>
                      </Card>
                    </Show>
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

function LlmAnalysisPanel(props: { analysis: LlmAnalysis }) {
  const { t } = useLingui();
  const confidenceVariant = (
    confidence: number,
  ): "secondary" | "warning" | "error" => {
    if (confidence >= 0.75) return "error";
    if (confidence >= 0.4) return "warning";
    return "secondary";
  };
  return (
    <div class="mt-3 rounded-md border border-dashed bg-muted/30 p-3">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <IconSparkles class="size-3.5" aria-hidden="true" />
        {t`LLM analysis (reference only, not a decision)`}
      </div>
      <Show
        when={props.analysis.error == null}
        fallback={
          <p class="text-xs text-muted-foreground">
            {t`The automated analysis was unavailable for this report.`}
          </p>
        }
      >
        <Show when={props.analysis.summary}>
          <p class="mb-2 text-sm">{props.analysis.summary}</p>
        </Show>
        <div class="flex flex-col gap-2">
          <For each={props.analysis.matches ?? []}>
            {(match) => (
              <div class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                  <Badge variant={confidenceVariant(match.confidence)}>
                    {match.provision} · {Math.round(match.confidence * 100)}%
                  </Badge>
                </div>
                <p class="text-xs text-muted-foreground">
                  {match.rationale}
                </p>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

import { graphql } from "relay-runtime";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox.tsx";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { CocProvisionItem } from "./ModerationActionForm.tsx";
import type { AppealResolveForm_resolve_Mutation } from "./__generated__/AppealResolveForm_resolve_Mutation.graphql.ts";

export interface AppealResolveFormProps {
  /** The appeal's global id. */
  appealId: string;
  /** The code of conduct provisions for a replacement action. */
  provisions: readonly CocProvisionItem[];
  /** Whether the appealed case still has a post target (gates `Censor post`). */
  canCensor: boolean;
  /** Called after a successful resolution so the page can refresh. */
  onResolved: () => void;
}

type AppealResult = "DISMISSED" | "WITHDRAWN" | "REDUCED" | "INCREASED";
type ReplacementType = "WARNING" | "CENSOR" | "SUSPEND" | "BAN";

const SUSPENSION_PRESETS = [1, 3, 7, 14, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const resolveMutation = graphql`
  mutation AppealResolveForm_resolve_Mutation(
    $appealId: ID!
    $result: FlagAppealResult!
    $reviewRationale: String!
    $replacement: ReplacementActionInput
  ) {
    resolveFlagAppeal(
      appealId: $appealId
      result: $result
      reviewRationale: $reviewRationale
      replacement: $replacement
    ) {
      __typename
      ... on FlagAppeal {
        id
        status
        result
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

export function AppealResolveForm(props: AppealResolveFormProps) {
  const { t } = useLingui();
  const [result, setResult] = createSignal<AppealResult | null>(null);
  const [reviewRationale, setReviewRationale] = createSignal("");
  const [replacementType, setReplacementType] = createSignal<
    ReplacementType | null
  >(null);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [replacementRationale, setReplacementRationale] = createSignal("");
  const [suspensionDays, setSuspensionDays] = createSignal(7);
  const [touched, setTouched] = createSignal(false);

  const [commit, submitting] = createMutation<
    AppealResolveForm_resolve_Mutation
  >(resolveMutation);

  const results: { value: AppealResult; label: string }[] = [
    { value: "DISMISSED", label: t`Deny (uphold decision)` },
    { value: "WITHDRAWN", label: t`Withdraw decision` },
    { value: "REDUCED", label: t`Reduce sanction` },
    { value: "INCREASED", label: t`Increase sanction` },
  ];

  const needsReplacement = () =>
    result() === "REDUCED" || result() === "INCREASED";

  const replacementTypes = createMemo(() => {
    const all: { value: ReplacementType; label: string }[] = [
      { value: "WARNING", label: t`Warning` },
      { value: "CENSOR", label: t`Censor post` },
      { value: "SUSPEND", label: t`Suspend` },
      { value: "BAN", label: t`Ban` },
    ];
    return props.canCensor ? all : all.filter((a) => a.value !== "CENSOR");
  });

  const provisionsBySection = createMemo(() => {
    const groups = new Map<string, CocProvisionItem[]>();
    for (const provision of props.provisions) {
      const list = groups.get(provision.section) ?? [];
      list.push(provision);
      groups.set(provision.section, list);
    }
    return [...groups.entries()];
  });

  const toggleProvision = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reviewMissing = () => reviewRationale().trim().length < 1;
  const replacementTypeMissing = () =>
    needsReplacement() && replacementType() == null;
  const replacementProvisionsMissing = () =>
    needsReplacement() && selected().size < 1;
  const replacementRationaleMissing = () =>
    needsReplacement() && replacementRationale().trim().length < 1;

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setTouched(true);
    const res = result();
    if (
      res == null || reviewMissing() || replacementTypeMissing() ||
      replacementProvisionsMissing() || replacementRationaleMissing()
    ) {
      return;
    }
    if (submitting()) return;

    let replacement: AppealResolveForm_resolve_Mutation["variables"][
      "replacement"
    ] = null;
    if (needsReplacement()) {
      const type = replacementType()!;
      let suspensionStarts: string | undefined;
      let suspensionEnds: string | undefined;
      if (type === "SUSPEND") {
        const now = new Date();
        suspensionStarts = now.toISOString();
        suspensionEnds = new Date(now.getTime() + suspensionDays() * DAY_MS)
          .toISOString();
      }
      replacement = {
        actionType: type,
        violatedProvisions: [...selected()],
        rationale: replacementRationale().trim(),
        suspensionStarts: suspensionStarts ?? null,
        suspensionEnds: suspensionEnds ?? null,
      };
    }

    commit({
      variables: {
        appealId: props.appealId,
        result: res,
        reviewRationale: reviewRationale().trim(),
        replacement,
      },
      onCompleted(response) {
        switch (response.resolveFlagAppeal.__typename) {
          case "FlagAppeal":
            showToast({
              title: t`Appeal resolved`,
              description: t`The appellant has been notified.`,
              variant: "success",
            });
            props.onResolved();
            break;
          case "InvalidInputError":
            showToast({
              title: t`Could not resolve the appeal`,
              description: t`Please check the form and try again.`,
              variant: "destructive",
            });
            break;
          default:
            showToast({
              title: t`Could not resolve the appeal`,
              variant: "destructive",
            });
        }
      },
      onError() {
        showToast({
          title: t`Could not resolve the appeal`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">{t`Outcome`}</legend>
        <div class="flex flex-wrap gap-2">
          <For each={results}>
            {(item) => (
              <Button
                type="button"
                variant={result() === item.value ? "default" : "outline"}
                size="sm"
                onClick={() => setResult(item.value)}
              >
                {item.label}
              </Button>
            )}
          </For>
        </div>
        <Show when={touched() && result() == null}>
          <p class="text-xs text-error-foreground">
            {t`Choose an outcome.`}
          </p>
        </Show>
      </fieldset>

      <Show when={needsReplacement()}>
        <fieldset class="flex flex-col gap-4 rounded-md border p-3">
          <legend class="px-1 text-sm font-medium">
            {t`Replacement sanction`}
          </legend>
          <div class="flex flex-wrap gap-2">
            <For each={replacementTypes()}>
              {(item) => (
                <Button
                  type="button"
                  variant={replacementType() === item.value
                    ? "default"
                    : "outline"}
                  size="sm"
                  onClick={() => setReplacementType(item.value)}
                >
                  {item.label}
                </Button>
              )}
            </For>
          </div>
          <Show when={touched() && replacementTypeMissing()}>
            <p class="text-xs text-error-foreground">
              {t`Choose the replacement sanction.`}
            </p>
          </Show>

          <div class="flex flex-col gap-3">
            <p class="text-sm font-medium">{t`Violated provisions`}</p>
            <For each={provisionsBySection()}>
              {([section, provisions]) => (
                <div class="flex flex-col gap-2">
                  <p class="text-xs font-semibold text-muted-foreground">
                    {section}
                  </p>
                  <For each={provisions}>
                    {(provision) => (
                      <Checkbox
                        checked={selected().has(provision.id)}
                        onChange={() => toggleProvision(provision.id)}
                        class="items-start"
                      >
                        <CheckboxLabel class="cursor-pointer font-normal leading-snug">
                          <span class="font-semibold">{provision.id}</span>{" "}
                          {provision.title}
                        </CheckboxLabel>
                      </Checkbox>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={touched() && replacementProvisionsMissing()}>
              <p class="text-xs text-error-foreground">
                {t`Select at least one violated provision.`}
              </p>
            </Show>
          </div>

          <Show when={replacementType() === "SUSPEND"}>
            <div class="flex flex-col gap-2">
              <p class="text-sm font-medium">{t`Suspension length`}</p>
              <div class="flex flex-wrap gap-2">
                <For each={SUSPENSION_PRESETS}>
                  {(days) => (
                    <Button
                      type="button"
                      variant={suspensionDays() === days
                        ? "default"
                        : "outline"}
                      size="sm"
                      onClick={() => setSuspensionDays(days)}
                    >
                      <Show when={days === 1} fallback={t`${days} days`}>
                        {t`1 day`}
                      </Show>
                    </Button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <TextField
            value={replacementRationale()}
            onChange={setReplacementRationale}
          >
            <TextFieldLabel>{t`Replacement rationale`}</TextFieldLabel>
            <TextFieldTextArea rows={2} />
            <Show when={touched() && replacementRationaleMissing()}>
              <p class="text-xs text-error-foreground">
                {t`A rationale is required.`}
              </p>
            </Show>
          </TextField>
        </fieldset>
      </Show>

      <TextField value={reviewRationale()} onChange={setReviewRationale}>
        <TextFieldLabel>
          {t`Review rationale (shown to the appellant)`}
        </TextFieldLabel>
        <TextFieldTextArea
          rows={3}
          placeholder={t`Explain the outcome under the moderation team's identity.`}
        />
        <Show when={touched() && reviewMissing()}>
          <p class="text-xs text-error-foreground">
            {t`A review rationale is required.`}
          </p>
        </Show>
      </TextField>

      <div class="flex justify-end">
        <Button type="submit" disabled={submitting()}>
          {t`Resolve appeal`}
        </Button>
      </div>
    </form>
  );
}

import { graphql } from "relay-runtime";
import { createMemo, createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ModerationActionForm_takeAction_Mutation } from "./__generated__/ModerationActionForm_takeAction_Mutation.graphql.ts";

export interface CocProvisionItem {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly text: string;
}

export interface ModerationActionFormProps {
  /** The case's global id. */
  caseId: string;
  /** The code of conduct provisions to choose from. */
  provisions: readonly CocProvisionItem[];
  /**
   * Whether the reported post still exists (gates the `Censor post` action;
   * a report whose post was deleted cannot be censored).
   */
  canCensor: boolean;
  /**
   * Whether a sanction will be forwarded to the target's remote instance
   * (the target is remote and at least one reporter opted in).  When true a
   * remote-safe summary is required for sanctions, so the internal rationale
   * is never externalized.
   */
  forwardingEnabled: boolean;
  /**
   * Whether the target is a local account.  Remote targets receive no
   * in-app message, so the "message to the user" field is hidden for them.
   */
  isLocal: boolean;
  /** Called after a successful action so the page can refresh. */
  onActioned: () => void;
}

type ActionType = "DISMISS" | "WARNING" | "CENSOR" | "SUSPEND" | "BAN";

const SUSPENSION_PRESETS = [1, 3, 7, 14, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const takeActionMutation = graphql`
  mutation ModerationActionForm_takeAction_Mutation(
    $caseId: ID!
    $actionType: FlagActionType!
    $violatedProvisions: [String!]
    $rationale: String!
    $messageToUser: String
    $suspensionStarts: DateTime
    $suspensionEnds: DateTime
    $forwardSummary: String
  ) {
    takeModerationAction(
      caseId: $caseId
      actionType: $actionType
      violatedProvisions: $violatedProvisions
      rationale: $rationale
      messageToUser: $messageToUser
      suspensionStarts: $suspensionStarts
      suspensionEnds: $suspensionEnds
      forwardSummary: $forwardSummary
    ) {
      __typename
      ... on FlagAction {
        id
        actionType
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

export function ModerationActionForm(props: ModerationActionFormProps) {
  const { t } = useLingui();
  const [actionType, setActionType] = createSignal<ActionType | null>(null);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [rationale, setRationale] = createSignal("");
  const [messageToUser, setMessageToUser] = createSignal("");
  const [forwardSummary, setForwardSummary] = createSignal("");
  const [suspensionDays, setSuspensionDays] = createSignal<number>(7);
  const [touched, setTouched] = createSignal(false);

  const [commit, submitting] = createMutation<
    ModerationActionForm_takeAction_Mutation
  >(takeActionMutation);

  const actionTypes = createMemo(() => {
    const all: {
      value: ActionType;
      label: string;
      needsProvisions: boolean;
    }[] = [
      { value: "DISMISS", label: t`Dismiss`, needsProvisions: false },
      { value: "WARNING", label: t`Warning`, needsProvisions: true },
      { value: "CENSOR", label: t`Censor post`, needsProvisions: true },
      { value: "SUSPEND", label: t`Suspend`, needsProvisions: true },
      { value: "BAN", label: t`Ban`, needsProvisions: true },
    ];
    return props.canCensor ? all : all.filter((a) => a.value !== "CENSOR");
  });

  const needsProvisions = () => {
    const at = actionType();
    return at != null && at !== "DISMISS";
  };

  // Forwarding only happens for non-dismiss actions on a forwarding-enabled
  // case.  Require a remote-safe summary then, so the server never falls back
  // to the internal rationale (which could carry reporter-identifying text).
  const requiresForwardSummary = () =>
    props.forwardingEnabled && actionType() != null &&
    actionType() !== "DISMISS";
  const forwardSummaryMissing = () =>
    requiresForwardSummary() && forwardSummary().trim().length < 1;

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

  const rationaleMissing = () => rationale().trim().length < 1;
  const provisionsMissing = () => needsProvisions() && selected().size < 1;

  const handleSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setTouched(true);
    const at = actionType();
    if (
      at == null || rationaleMissing() || provisionsMissing() ||
      forwardSummaryMissing()
    ) {
      return;
    }
    if (submitting()) return;

    let suspensionStarts: string | undefined;
    let suspensionEnds: string | undefined;
    if (at === "SUSPEND") {
      const now = new Date();
      suspensionStarts = now.toISOString();
      suspensionEnds = new Date(now.getTime() + suspensionDays() * DAY_MS)
        .toISOString();
    }

    commit({
      variables: {
        caseId: props.caseId,
        actionType: at,
        violatedProvisions: needsProvisions() ? [...selected()] : null,
        rationale: rationale().trim(),
        messageToUser: props.isLocal && messageToUser().trim()
          ? messageToUser().trim()
          : null,
        suspensionStarts: suspensionStarts ?? null,
        suspensionEnds: suspensionEnds ?? null,
        forwardSummary: requiresForwardSummary() && forwardSummary().trim()
          ? forwardSummary().trim()
          : null,
      },
      onCompleted(response) {
        const result = response.takeModerationAction;
        switch (result.__typename) {
          case "FlagAction":
            showToast({
              title: t`Action recorded`,
              description: t`The decision has been recorded and applied.`,
              variant: "success",
            });
            props.onActioned();
            break;
          case "InvalidInputError":
            showToast({
              title: t`Could not record the action`,
              description: t`Please check the form and try again.`,
              variant: "destructive",
            });
            break;
          default:
            showToast({
              title: t`Could not record the action`,
              variant: "destructive",
            });
        }
      },
      onError() {
        showToast({
          title: t`Could not record the action`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <form class="flex flex-col gap-5" onSubmit={handleSubmit}>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-sm font-medium">{t`Decision`}</legend>
        <div class="flex flex-wrap gap-2">
          <For each={actionTypes()}>
            {(item) => (
              <Button
                type="button"
                variant={actionType() === item.value ? "default" : "outline"}
                size="sm"
                onClick={() => setActionType(item.value)}
              >
                {item.label}
              </Button>
            )}
          </For>
        </div>
        <Show when={touched() && actionType() == null}>
          <p class="text-xs text-error-foreground">
            {t`Choose a decision.`}
          </p>
        </Show>
      </fieldset>

      <Show when={needsProvisions()}>
        <fieldset class="flex flex-col gap-3">
          <legend class="mb-1 text-sm font-medium">
            {t`Violated provisions`}
          </legend>
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
          <Show when={touched() && provisionsMissing()}>
            <p class="text-xs text-error-foreground">
              {t`Select at least one violated provision.`}
            </p>
          </Show>
        </fieldset>
      </Show>

      <Show when={actionType() === "SUSPEND"}>
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-sm font-medium">
            {t`Suspension length`}
          </legend>
          <div class="flex flex-wrap gap-2">
            <For each={SUSPENSION_PRESETS}>
              {(days) => (
                <Button
                  type="button"
                  variant={suspensionDays() === days ? "default" : "outline"}
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
        </fieldset>
      </Show>

      <TextField value={rationale()} onChange={setRationale}>
        <TextFieldLabel>{t`Internal rationale`}</TextFieldLabel>
        <TextFieldTextArea
          rows={3}
          placeholder={t`Recorded for the audit trail; not shown to the user.`}
        />
        <Show when={touched() && rationaleMissing()}>
          <p class="text-xs text-error-foreground">
            {t`A rationale is required.`}
          </p>
        </Show>
      </TextField>

      <Show when={props.isLocal}>
        <TextField value={messageToUser()} onChange={setMessageToUser}>
          <TextFieldLabel>{t`Message to the user (optional)`}</TextFieldLabel>
          <TextFieldTextArea
            rows={3}
            placeholder={t`Shown to the reported user under the moderation team's identity.`}
          />
        </TextField>
      </Show>

      <Show when={requiresForwardSummary()}>
        <TextField value={forwardSummary()} onChange={setForwardSummary}>
          <TextFieldLabel>
            {t`Summary for the remote instance`}
          </TextFieldLabel>
          <TextFieldTextArea
            rows={2}
            placeholder={t`A reporter opted in to forwarding, so this is sent to the remote instance. Never include the reporter's wording.`}
          />
          <Show when={touched() && forwardSummaryMissing()}>
            <p class="text-xs text-error-foreground">
              {t`A summary is required because this report will be forwarded.`}
            </p>
          </Show>
        </TextField>
      </Show>

      <div class="flex justify-end">
        <Button type="submit" disabled={submitting()}>
          {t`Record decision`}
        </Button>
      </div>
    </form>
  );
}

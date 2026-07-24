import { type Uuid } from "@hackerspub/models/uuid";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.tsx";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { AppealDialog_appeal_Mutation } from "./__generated__/AppealDialog_appeal_Mutation.graphql.ts";

const MAX_REASON_LENGTH = 4096;

const appealMutation = graphql`
  mutation AppealDialog_appeal_Mutation(
    $sanctionId: UUID!
    $reason: String!
    $additionalContext: String
  ) {
    appealModerationAction(
      sanctionId: $sanctionId
      reason: $reason
      additionalContext: $additionalContext
    ) {
      __typename
      ... on FlagAppeal {
        id
        status
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`;

export interface AppealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sanction's row UUID (`Sanction.uuid`). */
  sanctionId: string;
  /** Called after a successful appeal so the page can refresh. */
  onSuccess?: () => void;
}

export function AppealDialog(props: AppealDialogProps) {
  const { t } = useLingui();
  const [reason, setReason] = createSignal("");
  const [additionalContext, setAdditionalContext] = createSignal("");
  const [touched, setTouched] = createSignal(false);

  const [commit, submitting] =
    createMutation<AppealDialog_appeal_Mutation>(appealMutation);

  const reasonTooShort = () => reason().trim().length < 1;
  const reasonTooLong = () => reason().trim().length > MAX_REASON_LENGTH;
  const contextTooLong = () =>
    additionalContext().trim().length > MAX_REASON_LENGTH;

  const reset = () => {
    setReason("");
    setAdditionalContext("");
    setTouched(false);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) reset();
    props.onOpenChange(open);
  };

  const handleSubmit = () => {
    setTouched(true);
    if (reasonTooShort() || reasonTooLong() || contextTooLong()) return;
    if (submitting()) return;
    commit({
      variables: {
        sanctionId: props.sanctionId as Uuid,
        reason: reason().trim(),
        additionalContext: additionalContext().trim() || null,
      },
      onCompleted(response) {
        switch (response.appealModerationAction.__typename) {
          case "FlagAppeal":
            showToast({
              title: t`Appeal submitted`,
              description: t`The moderation team will review your appeal and notify you.`,
              variant: "success",
            });
            handleOpenChange(false);
            props.onSuccess?.();
            break;
          default:
            showToast({
              title: t`Could not submit the appeal`,
              description: t`You may have already appealed, or the appeal window has closed.`,
              variant: "destructive",
            });
        }
      },
      onError() {
        showToast({
          title: t`Could not submit the appeal`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t`Appeal this decision`}</DialogTitle>
          <DialogDescription>
            {t`Tell the moderation team why you believe this decision is unjust. You can appeal once, within 14 days of the decision.`}
          </DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-4">
          <TextField
            value={reason()}
            onChange={setReason}
            validationState={
              touched() && (reasonTooShort() || reasonTooLong())
                ? "invalid"
                : "valid"
            }
          >
            <TextFieldLabel>{t`Why is this decision unjust?`}</TextFieldLabel>
            <TextFieldTextArea
              rows={4}
              placeholder={t`Explain in your own words.`}
              onBlur={() => setTouched(true)}
            />
            <Show when={touched() && reasonTooShort()}>
              <p class="text-xs text-error-foreground">
                {t`A reason is required.`}
              </p>
            </Show>
            <Show when={reasonTooLong()}>
              <p class="text-xs text-error-foreground">
                {t`The reason is too long (maximum ${MAX_REASON_LENGTH} characters).`}
              </p>
            </Show>
          </TextField>
          <TextField
            value={additionalContext()}
            onChange={setAdditionalContext}
            validationState={contextTooLong() ? "invalid" : "valid"}
          >
            <TextFieldLabel>{t`Additional context (optional)`}</TextFieldLabel>
            <TextFieldTextArea
              rows={3}
              placeholder={t`Anything you believe was not considered.`}
            />
            <Show when={contextTooLong()}>
              <p class="text-xs text-error-foreground">
                {t`This is too long (maximum ${MAX_REASON_LENGTH} characters).`}
              </p>
            </Show>
          </TextField>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting()}
          >
            {t`Cancel`}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting()}>
            {t`Submit appeal`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

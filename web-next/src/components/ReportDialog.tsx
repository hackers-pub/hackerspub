import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  Checkbox,
  CheckboxDescription,
  CheckboxLabel,
} from "~/components/ui/checkbox.tsx";
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
import IconShieldAlert from "~icons/lucide/shield-alert";
import type { ReportDialog_reportContent_Mutation } from "./__generated__/ReportDialog_reportContent_Mutation.graphql.ts";

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 4096;

const reportContentMutation = graphql`
  mutation ReportDialog_reportContent_Mutation(
    $targetId: ID!
    $reason: String!
    $forwardToRemote: Boolean
  ) {
    reportContent(
      targetId: $targetId
      reason: $reason
      forwardToRemote: $forwardToRemote
    ) {
      __typename
      ... on Flag {
        id
        status
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on DuplicateReportError {
        duplicateReport
      }
    }
  }
`;

export interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The reported target's global id: an `Actor`, or a post. */
  targetId: string;
  /** Whether a post or a whole account is being reported. */
  targetKind: "post" | "user";
  /** The reported actor's fediverse handle, e.g. `@user@host`. */
  targetHandle: string;
  /**
   * Whether the target lives on a remote instance, which offers the
   * reporter the opt-in to forward the report there.
   */
  targetIsRemote: boolean;
}

export function ReportDialog(props: ReportDialogProps) {
  const { t } = useLingui();
  const [reason, setReason] = createSignal("");
  const [forwardToRemote, setForwardToRemote] = createSignal(false);
  const [touched, setTouched] = createSignal(false);

  const [commitReport, isReporting] =
    createMutation<ReportDialog_reportContent_Mutation>(reportContentMutation);

  const trimmedLength = createMemo(() => reason().trim().length);
  const tooShort = () => trimmedLength() < MIN_REASON_LENGTH;
  const tooLong = () => trimmedLength() > MAX_REASON_LENGTH;

  const reset = () => {
    setReason("");
    setForwardToRemote(false);
    setTouched(false);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) reset();
    props.onOpenChange(open);
  };

  const handleSubmit = () => {
    setTouched(true);
    if (tooShort() || tooLong() || isReporting()) return;
    commitReport({
      variables: {
        targetId: props.targetId,
        reason: reason().trim(),
        forwardToRemote: props.targetIsRemote ? forwardToRemote() : false,
      },
      onCompleted(response) {
        switch (response.reportContent.__typename) {
          case "Flag":
            showToast({
              title: t`Report submitted`,
              description: t`Thank you. The moderation team will review your report.`,
              variant: "success",
            });
            handleOpenChange(false);
            break;
          case "DuplicateReportError":
            showToast({
              title: t`Already reported`,
              description: t`You already have an open report on this target. You can check its status in your report history.`,
            });
            handleOpenChange(false);
            break;
          default:
            showToast({
              title: t`Failed to submit report`,
              variant: "destructive",
            });
        }
      },
      onError() {
        showToast({
          title: t`Failed to submit report`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <IconShieldAlert class="size-5" aria-hidden="true" />
            <Show
              when={props.targetKind === "post"}
              fallback={t`Report ${props.targetHandle}`}
            >
              {t`Report this post`}
            </Show>
          </DialogTitle>
          <DialogDescription>
            <Show
              when={props.targetKind === "post"}
              fallback={t`Tell the moderation team why you are reporting this user. You don't need to know the specific code of conduct provisions; describe what felt uncomfortable or problematic in your own words.`}
            >
              {t`Tell the moderation team why you are reporting this post. You don't need to know the specific code of conduct provisions; describe what felt uncomfortable or problematic in your own words.`}
            </Show>
          </DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-4">
          <TextField
            value={reason()}
            onChange={setReason}
            validationState={
              touched() && (tooShort() || tooLong()) ? "invalid" : "valid"
            }
          >
            <TextFieldLabel>{t`Reason`}</TextFieldLabel>
            <TextFieldTextArea
              rows={5}
              placeholder={t`What happened?`}
              onBlur={() => setTouched(true)}
            />
            <p
              class="text-xs"
              classList={{
                "text-muted-foreground":
                  !(touched() && tooShort()) && !tooLong(),
                "text-error-foreground": (touched() && tooShort()) || tooLong(),
              }}
            >
              <Show
                when={tooLong()}
                fallback={t`Minimum ${MIN_REASON_LENGTH} characters required.`}
              >
                {t`The reason is too long (maximum ${MAX_REASON_LENGTH} characters).`}
              </Show>
            </p>
          </TextField>
          <Show when={props.targetIsRemote}>
            <Checkbox
              checked={forwardToRemote()}
              onChange={setForwardToRemote}
              class="items-start"
            >
              <div class="grid gap-1 leading-snug">
                <CheckboxLabel class="cursor-pointer font-normal leading-snug">
                  {t`Also send this report to the remote instance (${props.targetHandle})`}
                </CheckboxLabel>
                <CheckboxDescription class="text-xs leading-snug">
                  {t`If enabled, a report will be sent to the remote server's moderators after our moderation team acts. Your identity will not be revealed; only a summary written by our moderation team is shared, never your original wording.`}
                </CheckboxDescription>
              </div>
            </Checkbox>
          </Show>
          <p class="text-xs text-muted-foreground border-t pt-3">
            {t`Your identity is kept strictly confidential: only the moderation team can see who reported, and the reported user never will.`}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isReporting()}
          >
            {t`Cancel`}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isReporting() || tooShort() || tooLong()}
          >
            {t`Submit report`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

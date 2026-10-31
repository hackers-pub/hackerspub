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
  DialogTrigger,
} from "~/components/ui/dialog.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type { GrantInvitationsDialog_grant_Mutation } from "~/__generated__/GrantInvitationsDialog_grant_Mutation.graphql.ts";

const grantInvitationsMutation = graphql`
  mutation GrantInvitationsDialog_grant_Mutation(
    $input: GrantInvitationsInput!
  ) {
    grantInvitations(input: $input) {
      __typename
      ... on GrantInvitationsPayload {
        granted
        previousBalance
        newBalance
        account {
          id
          invitationsLeft
        }
        distribution {
          uuid
          amount
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

export interface GrantInvitationsDialogProps {
  /** The target account's global id. */
  accountId: string;
  username: string;
  invitationsLeft: number;
  onGranted?: () => void;
}

export function GrantInvitationsDialog(props: GrantInvitationsDialogProps) {
  const { i18n, t } = useLingui();
  const [open, setOpen] = createSignal(false);
  const [amount, setAmount] = createSignal("1");
  const [note, setNote] = createSignal("");
  const [message, setMessage] = createSignal<string | null>(null);
  const [grant, submitting] =
    createMutation<GrantInvitationsDialog_grant_Mutation>(
      grantInvitationsMutation,
    );

  const parsedAmount = () => {
    const value = Number(amount());
    return Number.isSafeInteger(value) ? value : NaN;
  };

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAmount("1");
      setNote("");
      setMessage(null);
    }
  }

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    setMessage(null);
    const value = parsedAmount();
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
      setMessage(t`Enter a whole number between 1 and 10,000.`);
      return;
    }
    grant({
      variables: {
        input: {
          accountId: props.accountId,
          amount: value,
          note: note().trim() === "" ? null : note().trim(),
        },
      },
      onCompleted(response) {
        const result = response.grantInvitations;
        if (result.__typename === "GrantInvitationsPayload") {
          showToast({
            title: i18n._(
              msg`Granted ${plural(result.granted!, {
                one: "# invitation",
                other: "# invitations",
              })} to @${props.username}. New balance: ${result.newBalance}.`,
            ),
          });
          setOpen(false);
          props.onGranted?.();
          setAmount("1");
          setNote("");
        } else if (result.__typename === "InvalidInputError") {
          setMessage(
            result.inputPath === "note"
              ? t`The note must be 500 characters or fewer.`
              : result.inputPath === "amount"
                ? t`Enter a whole number between 1 and 10,000.`
                : t`That account could not be found.`,
          );
        } else if (result.__typename === "NotAuthenticatedError") {
          setMessage(t`Your session expired. Sign in again to continue.`);
        } else {
          setMessage(t`You are not authorized to grant invitations.`);
        }
      },
      onError(error) {
        setMessage(t`Failed to grant invitations.`);
        if (import.meta.env.DEV) console.error(error);
      },
    });
  }

  return (
    <Dialog open={open()} onOpenChange={handleOpenChange}>
      <DialogTrigger
        as={(triggerProps: Record<string, unknown>) => (
          <Button variant="outline" size="sm" {...triggerProps}>
            {t`Grant invitations`}
          </Button>
        )}
      />
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t`Grant invitations`}</DialogTitle>
          <DialogDescription>
            {t`Give @${props.username} invitation slots directly. Their current balance is ${props.invitationsLeft}.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} class="space-y-4">
          <TextField value={amount()} onChange={setAmount}>
            <TextFieldLabel>{t`Amount`}</TextFieldLabel>
            <TextFieldInput
              type="number"
              min="1"
              max="10000"
              step="1"
              required
            />
          </TextField>
          <TextField value={note()} onChange={setNote}>
            <TextFieldLabel>{t`Note (optional)`}</TextFieldLabel>
            <TextFieldTextArea maxLength={500} rows={3} />
            <p class="text-xs text-muted-foreground">
              {t`${note().length} / 500 characters`}
            </p>
          </TextField>
          <Show keyed when={message()}>
            {(error) => (
              <p class="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </Show>
          <DialogFooter>
            <Button type="submit" disabled={submitting()}>
              {submitting() ? t`Granting…` : t`Grant`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

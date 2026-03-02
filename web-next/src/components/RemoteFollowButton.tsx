import { fetchQuery, graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
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
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  RemoteFollowButton_lookupWebFingerQuery,
  RemoteFollowButton_lookupWebFingerQuery$data,
} from "./__generated__/RemoteFollowButton_lookupWebFingerQuery.graphql.ts";

export interface RemoteFollowButtonProps {
  actorHandle: string;
  actorName?: string | null;
}

const FEDIVERSE_ID_REGEX =
  /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;

const lookupWebFingerQuery = graphql`
  query RemoteFollowButton_lookupWebFingerQuery(
    $fediverseId: String!
    $actorHandle: String!
  ) {
    lookupWebFinger(fediverseId: $fediverseId, actorHandle: $actorHandle) {
      preferredUsername
      name
      summary
      url
      iconUrl
      handle
      domain
      software
      emojis
      remoteFollowUrl
    }
  }
`;

type WebFingerResult = NonNullable<
  RemoteFollowButton_lookupWebFingerQuery$data["lookupWebFinger"]
>;

export function RemoteFollowButton(props: RemoteFollowButtonProps) {
  const { t } = useLingui();
  const env = useRelayEnvironment();
  const [open, setOpen] = createSignal(false);
  const [fediverseId, setFediverseId] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [actorInfo, setActorInfo] = createSignal<WebFingerResult | null>(null);

  const resetState = () => {
    setFediverseId("");
    setError("");
    setActorInfo(null);
    setIsLoading(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) resetState();
  };

  const handleInputChange = (value: string) => {
    setFediverseId(value);
    if (error()) setError("");
    if (actorInfo()) setActorInfo(null);
  };

  const handleLookup = async (e: Event) => {
    e.preventDefault();

    const inputId = fediverseId().trim();
    if (!inputId) {
      setError(t`Please enter your Fediverse handle.`);
      return;
    }

    if (!FEDIVERSE_ID_REGEX.test(inputId)) {
      setError(t`Invalid Fediverse handle format.`);
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const result = await fetchQuery<
        RemoteFollowButton_lookupWebFingerQuery
      >(
        env(),
        lookupWebFingerQuery,
        {
          fediverseId: inputId,
          actorHandle: props.actorHandle,
        },
      ).toPromise();

      if (result?.lookupWebFinger) {
        setActorInfo(result.lookupWebFinger);
      } else {
        setError(t`User not found.`);
      }
    } catch {
      setError(t`Failed to look up user.`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFollow = () => {
    const info = actorInfo();
    if (!info) return;

    if (!info.remoteFollowUrl) {
      setError(t`This service does not support remote follow.`);
      return;
    }

    window.open(info.remoteFollowUrl, "_blank", "noopener,noreferrer");
    handleOpenChange(false);
  };

  const displayName = () => props.actorName || props.actorHandle;

  const actorDisplayName = () => {
    const info = actorInfo();
    if (!info) return "";
    return info.name || info.preferredUsername ||
      info.handle?.replace(/^@/, "").split("@")[0] ||
      "";
  };

  return (
    <Dialog open={open()} onOpenChange={handleOpenChange}>
      <DialogTrigger
        as={(triggerProps: Record<string, unknown>) => (
          <Button
            variant="outline"
            size="sm"
            class="cursor-pointer"
            {...triggerProps}
          >
            {t`Remote Follow`}
          </Button>
        )}
      />
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t`Remote Follow`}</DialogTitle>
          <DialogDescription>
            {t`To follow ${displayName()}, enter your Fediverse handle.`}
          </DialogDescription>
        </DialogHeader>

        <Show
          when={actorInfo()}
          fallback={
            <form onSubmit={handleLookup}>
              <div class="space-y-4">
                <TextField
                  value={fediverseId()}
                  onChange={handleInputChange}
                  validationState={error() ? "invalid" : "valid"}
                >
                  <TextFieldLabel>{t`Fediverse handle`}</TextFieldLabel>
                  <TextFieldInput
                    type="text"
                    placeholder={t`e.g., @user@mastodon.social`}
                    disabled={isLoading()}
                  />
                  <TextFieldErrorMessage>{error()}</TextFieldErrorMessage>
                </TextField>

                <Show when={isLoading()}>
                  <p class="text-sm text-muted-foreground">
                    {t`Looking up user...`}
                  </p>
                </Show>

                <DialogFooter>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => handleOpenChange(false)}
                  >
                    {t`Cancel`}
                  </Button>
                  <Button type="submit" disabled={isLoading()}>
                    {t`Look up user`}
                  </Button>
                </DialogFooter>
              </div>
            </form>
          }
        >
          {(info) => (
            <div class="space-y-4">
              <div class="flex items-start gap-3 rounded-md border p-3">
                <Show when={info().iconUrl}>
                  {(iconUrl) => (
                    <Avatar class="size-10 flex-shrink-0">
                      <AvatarImage src={iconUrl()} />
                      <AvatarFallback>
                        {actorDisplayName().charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  )}
                </Show>
                <div class="flex-1 min-w-0">
                  <h4 class="font-medium truncate">
                    {actorDisplayName()}
                  </h4>
                  <p class="text-sm text-muted-foreground truncate">
                    {info().handle}
                  </p>
                  <Show
                    when={info().software && info().software !== "unknown"}
                  >
                    <p class="text-xs text-muted-foreground">
                      {info().software!.charAt(0).toUpperCase() +
                        info().software!.slice(1)}
                    </p>
                  </Show>
                  <Show when={info().summary}>
                    {(summary) => (
                      <p class="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {summary().replace(/<[^>]*>/g, "").substring(0, 100)}
                        {summary().length > 100 ? "..." : ""}
                      </p>
                    )}
                  </Show>
                </div>
              </div>

              <Show when={error()}>
                <p class="text-sm text-destructive">{error()}</p>
              </Show>

              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setActorInfo(null);
                    setError("");
                  }}
                >
                  {t`Cancel`}
                </Button>
                <Button type="button" onClick={handleFollow}>
                  {t`Remote Follow`}
                </Button>
              </DialogFooter>
            </div>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}

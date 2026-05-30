import { A, useLocation } from "@solidjs/router";
import { Match, Switch } from "solid-js";
import { NoteComposer } from "~/components/NoteComposer.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { buildSignInHref } from "~/lib/authGate.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface NewsDiscussionComposerProps {
  /** The discussed link's URL; appended to a posted opinion if absent. */
  url: string;
  /** Called after a note is posted, to refresh the discussion roots. */
  onPosted: () => void;
}

export function NewsDiscussionComposer(props: NewsDiscussionComposerProps) {
  const { t } = useLingui();
  const { isAuthenticated, isLoaded } = useViewer();
  const location = useLocation();
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <Switch>
      <Match when={isLoaded() && isAuthenticated()}>
        <div class="mt-4 rounded-lg border bg-card p-4 shadow-sm">
          <NoteComposer
            ensureLinkUrl={props.url}
            defaultVisibility="PUBLIC"
            placeholder={t`Share your opinion on this story…`}
            onSuccess={props.onPosted}
          />
          <p class="mt-2 text-xs text-muted-foreground/70">
            {t`The link to this story is added to your post automatically.`}
          </p>
        </div>
      </Match>
      <Match when={isLoaded() && !isAuthenticated()}>
        <div class="mt-4 flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm">
          <p class="text-sm text-muted-foreground">
            {t`Join the discussion about this story.`}
          </p>
          <Button as={A} href={signInHref()} variant="outline" size="sm">
            {t`Sign in to post`}
          </Button>
        </div>
      </Match>
    </Switch>
  );
}

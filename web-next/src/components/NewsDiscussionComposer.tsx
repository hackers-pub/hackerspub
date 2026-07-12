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
  /**
   * The `NewsDiscussion__sharingPosts` connection record id.  A posted opinion
   * is prepended into this connection (`@prependNode`) so it appears at the top
   * of the list without refetching and redrawing the whole discussion.
   */
  connectionId: string;
}

export function NewsDiscussionComposer(props: NewsDiscussionComposerProps) {
  const { t } = useLingui();
  const { isAuthenticated: authenticated, isLoaded: loaded } = useViewer();
  const location = useLocation();
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <Switch>
      <Match when={loaded() && authenticated()}>
        <div class="mt-4 rounded-lg border bg-card p-4 shadow-sm">
          <NoteComposer
            ensureLinkUrl={props.url}
            defaultVisibility="PUBLIC"
            placeholder={t`Share your opinion on this story…`}
            prependToConnections={[props.connectionId]}
            allowPoll={false}
          />
          <p class="mt-2 text-xs text-muted-foreground/70">
            {t`The link to this story is added to your post automatically.`}
          </p>
        </div>
      </Match>
      <Match when={loaded() && !authenticated()}>
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

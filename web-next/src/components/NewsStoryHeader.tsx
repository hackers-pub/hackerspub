import { graphql } from "relay-runtime";
import { createMemo, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { NewsStoryHeader_story$key } from "./__generated__/NewsStoryHeader_story.graphql.ts";

export interface NewsStoryHeaderProps {
  $story: NewsStoryHeader_story$key;
}

export function NewsStoryHeader(props: NewsStoryHeaderProps) {
  const { t, i18n } = useLingui();
  const { openWithContent } = useNoteCompose();
  const story = createFragment(
    graphql`
      fragment NewsStoryHeader_story on PostLink {
        url
        title
        siteName
        description
        postCount
        firstSharedAt
        image {
          url
          alt
          width
          height
        }
        sourceBreakdown {
          local
          remote
          bluesky
        }
      }
    `,
    () => props.$story,
  );

  const host = createMemo(() => {
    const s = story();
    if (s == null) return "";
    try {
      return new URL(s.url).host.replace(/^www\./, "");
    } catch {
      return s.url;
    }
  });

  const sharesText = (count: number) =>
    i18n._(msg`${plural(count, { one: "# share", other: "# shares" })}`);

  return (
    <Show keyed when={story()}>
      {(s) => (
        <div class="overflow-hidden rounded-lg border bg-card shadow-sm">
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            class="grid gap-0 transition-colors hover:bg-muted/30 data-[image=true]:sm:grid-cols-[12rem_1fr]"
            data-image={s.image != null}
          >
            <Show keyed when={s.image}>
              {(img) => (
                <div class="border-b bg-muted/40 sm:border-r sm:border-b-0">
                  <img
                    src={img.url}
                    alt={img.alt ?? ""}
                    width={img.width ?? undefined}
                    height={img.height ?? undefined}
                    class="h-full max-h-48 w-full object-cover sm:max-h-none"
                  />
                </div>
              )}
            </Show>
            <div class="min-w-0 p-5">
              <p class="text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
                <span>{host()}</span>
                <Show when={s.siteName && s.siteName !== host()}>
                  <span>· {s.siteName}</span>
                </Show>
              </p>
              <h1 class="mt-1.5 text-xl font-semibold tracking-tight break-words">
                {s.title || host()}
              </h1>
              <Show keyed when={s.description}>
                {(description) => (
                  <p class="mt-2 line-clamp-3 text-sm break-words text-muted-foreground">
                    {description}
                  </p>
                )}
              </Show>
            </div>
          </a>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/40 px-5 py-3 text-sm text-muted-foreground">
            <span class="font-medium text-foreground">
              {sharesText(s.postCount)}
            </span>
            <Show keyed when={s.firstSharedAt}>
              {(at) => (
                <span>
                  {t`First shared`} <Timestamp value={at} />
                </span>
              )}
            </Show>
            <Show when={s.sourceBreakdown.local > 0}>
              <span>{t`${s.sourceBreakdown.local} from Hackers' Pub`}</span>
            </Show>
            <Show when={s.sourceBreakdown.remote > 0}>
              <span>{t`${s.sourceBreakdown.remote} from the fediverse`}</span>
            </Show>
            <Show when={s.sourceBreakdown.bluesky > 0}>
              <span>{t`${s.sourceBreakdown.bluesky} from Bluesky`}</span>
            </Show>
            <Button
              variant="outline"
              size="sm"
              class="ms-auto"
              onClick={() => openWithContent(`${s.url}\n\n`)}
            >
              {t`Share this link`}
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}

import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { NewsStoryCard_story$key } from "./__generated__/NewsStoryCard_story.graphql.ts";

export interface NewsStoryCardProps {
  $story: NewsStoryCard_story$key;
}

export function NewsStoryCard(props: NewsStoryCardProps) {
  const { t, i18n } = useLingui();
  const { openWithContent } = useNoteCompose();
  const story = createFragment(
    graphql`
      fragment NewsStoryCard_story on PostLink {
        uuid
        url
        title
        siteName
        description
        discussionCount
        latestActivityAt
        image {
          url
          alt
          width
          height
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

  const opinionsText = (count: number) =>
    i18n._(msg`${plural(count, { one: "# opinion", other: "# opinions" })}`);

  return (
    <Show keyed when={story()}>
      {(s) => (
        <article class="flex gap-3 border-b px-4 py-3 transition-colors last:border-none hover:bg-muted/30">
          {/* Discussion count, doubling as the link into the conversation. */}
          <A
            href={`/news/${s.uuid}`}
            aria-label={opinionsText(s.discussionCount)}
            title={opinionsText(s.discussionCount)}
            class="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch rounded-md py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              aria-hidden="true"
              class="size-5"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z"
              />
            </svg>
            <span class="text-sm font-semibold text-foreground tabular-nums">
              {s.discussionCount}
            </span>
          </A>

          <div class="min-w-0 flex-1">
            <h2 class="text-base font-semibold leading-snug tracking-tight">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                class="line-clamp-2 break-words hover:underline"
              >
                {s.title || host()}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  aria-hidden="true"
                  class="ml-1 inline-block size-3.5 shrink-0 align-baseline text-muted-foreground/70"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
              </a>
            </h2>
            <p class="mt-0.5 truncate text-xs text-muted-foreground/70">
              <span class="font-medium">{host()}</span>
              <Show when={s.siteName && s.siteName !== host()}>
                <span>· {s.siteName}</span>
              </Show>
            </p>
            <Show when={s.description}>
              <p class="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {s.description}
              </p>
            </Show>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => openWithContent(`${s.url}\n\n`)}
                class="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  aria-hidden="true"
                  class="size-3.5"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Zm0 0L19.5 7.125"
                  />
                </svg>
                {t`Share this link`}
              </button>
              <Show keyed when={s.latestActivityAt}>
                {(at) => (
                  <>
                    <span aria-hidden="true">·</span>
                    <span class="text-muted-foreground/70">
                      {t`Last active`}{" "}
                      <Timestamp value={at} relativeStyle="narrow" />
                    </span>
                  </>
                )}
              </Show>
            </div>
          </div>

          <Show keyed when={s.image}>
            {(img) => (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-hidden="true"
                tabindex={-1}
                class="hidden shrink-0 self-start sm:block"
              >
                <img
                  src={img.url}
                  alt={img.alt ?? ""}
                  width={img.width ?? undefined}
                  height={img.height ?? undefined}
                  class="size-16 rounded-md border bg-muted/40 object-cover"
                />
              </a>
            )}
          </Show>
        </article>
      )}
    </Show>
  );
}

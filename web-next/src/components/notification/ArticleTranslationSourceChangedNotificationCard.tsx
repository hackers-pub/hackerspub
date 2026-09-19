import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { createFragment } from "solid-relay";
import IconArrowRight from "~icons/lucide/arrow-right";
import { LanguageName } from "~/components/LanguageName.tsx";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { ArticleTranslationSourceChangedNotificationCard_notification$key } from "./__generated__/ArticleTranslationSourceChangedNotificationCard_notification.graphql.ts";

interface ArticleTranslationSourceChangedNotificationCardProps {
  $notification: ArticleTranslationSourceChangedNotificationCard_notification$key;
}

export function ArticleTranslationSourceChangedNotificationCard(
  props: ArticleTranslationSourceChangedNotificationCardProps,
) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ArticleTranslationSourceChangedNotificationCard_notification on ArticleTranslationSourceChangedNotification {
        ...NotificationMessage_notification
        languages
        article {
          name
          publishedYear
          slug
          actor {
            username
            handle
            local
          }
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`The original of ${"TITLE"} changed; review your translation`}
            multipleActorMessage={t`The original of ${"TITLE"} changed; review your translation`}
            $notification={notification}
            additionalValues={{
              TITLE: () => (
                <span class="font-semibold">
                  {notification.article?.name ?? t`an article`}
                </span>
              ),
            }}
          />
          <div class="-mt-2 mb-4 ml-20 mr-4 flex flex-wrap items-center gap-3">
            {/* The stored languages are what needed review when the
                notification was raised; a recipient who has since lost access
                receives an empty list and only sees the message above. */}
            <Show when={notification.languages.length > 0}>
              <p class="text-sm text-muted-foreground">
                <For each={notification.languages}>
                  {(language, index) => (
                    <>
                      <Show when={index() > 0}>{", "}</Show>
                      <LanguageName code={language} />
                    </>
                  )}
                </For>
              </p>
            </Show>
            <Show keyed when={translationsHref(notification.article)}>
              {(href) => (
                <Button
                  as={A}
                  href={href}
                  variant="outline"
                  size="sm"
                  preload={false}
                >
                  {t`Manage translations`}
                  <IconArrowRight />
                </Button>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * The translation management screen for the article, routed by its saved owner
 * rather than by the viewer's current compose-account preference.
 */
function translationsHref(
  article:
    | {
        readonly publishedYear: number | null | undefined;
        readonly slug: string | null | undefined;
        readonly actor: {
          readonly username: string | null | undefined;
          readonly handle: string;
          readonly local: boolean;
        };
      }
    | null
    | undefined,
): string | undefined {
  if (article?.publishedYear == null || article.slug == null) return undefined;
  const { actor } = article;
  const owner =
    actor.local && actor.username != null ? `@${actor.username}` : actor.handle;
  return `/${owner}/${article.publishedYear}/${encodeURIComponent(article.slug)}/translations`;
}

import { escape } from "@std/html/entities";
import { useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Msg, Translation, TranslationSetup } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import type { Language } from "../i18n.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import { preprocessContentHtml } from "../models/html.ts";
import type { Account, Actor } from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { Link } from "./Link.tsx";

export interface RecommendedActorsProps {
  language: Language;
  actors: (Actor & { account?: Account | null })[];
  actorMentions: { actor: Actor }[];
  window: number;
  title: boolean;
  class?: string;
}

export function RecommendedActors(
  { language, actors, actorMentions, window, title, class: klass }:
    RecommendedActorsProps,
) {
  const [shownActors, setShownActors] = useState(actors.slice(0, window));
  const [hiddenActors, setHiddenActors] = useState(actors.slice(window));
  const [followingActors, setFollowingActors] = useState(new Set<Uuid>());
  return (
    <TranslationSetup language={language}>
      <Translation>
        {(t) => (
          <>
            {title && (
              <PageTitle
                subtitle={{ text: t("recommendedActors.description") }}
              >
                <Msg $key="recommendedActors.title" />
              </PageTitle>
            )}
            <div
              class={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${
                klass ?? ""
              }`}
            >
              {shownActors.map((actor, index) => (
                <div
                  key={actor.id}
                  class="bg-stone-100 dark:bg-stone-800 p-4 flex flex-col h-full"
                >
                  <div class="grow">
                    <div class="flex space-x-4">
                      <img
                        src={actor.avatarUrl ??
                          "https://gravatar.com/avatar/?d=mp&s=128"}
                        alt={actor.name ?? undefined}
                        class="w-12 h-12"
                      />
                      <div class="grow">
                        <h2 class="text-lg font-semibold">
                          <Link
                            internalHref={actor.accountId == null
                              ? `/${actor.handle}`
                              : `/@${actor.username}`}
                            href={actor.url ?? actor.iri}
                          >
                            {actor.name == null ? actor.username : (
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: renderCustomEmojis(
                                    escape(actor.name),
                                    actor.emojis,
                                  ),
                                }}
                              />
                            )}
                          </Link>
                        </h2>
                        <p class="text-stone-500">
                          <Link
                            internalHref={actor.accountId == null
                              ? `/${actor.handle}`
                              : `/@${actor.username}`}
                            href={actor.url ?? actor.iri}
                            class="select-all"
                          >
                            {actor.handle}
                          </Link>
                        </p>
                      </div>
                      <button
                        type="button"
                        class="size-6"
                        onClick={() => {
                          setHiddenActors((hiddenActors) =>
                            hiddenActors.slice(1)
                          );
                          setShownActors((actors) => [
                            ...actors.slice(0, index),
                            ...hiddenActors.slice(0, 1),
                            ...actors.slice(index + 1),
                          ]);
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                          className="size-6 stroke-stone-400 hover:stroke-stone-800 dark:stroke-stone-500 dark:hover:stroke-stone-100 hover:stroke-2"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M6 18 18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                    <div
                      class="mt-4 prose dark:prose-invert"
                      dangerouslySetInnerHTML={{
                        __html: preprocessContentHtml(
                          actor.bioHtml ?? "",
                          {
                            mentions: actorMentions,
                            emojis: actor.emojis,
                          },
                        ),
                      }}
                    />
                  </div>
                  <Button
                    class="mt-4 w-full grow-0"
                    disabled={followingActors.has(actor.id)}
                    onClick={() => {
                      setHiddenActors((hiddenActors) => hiddenActors.slice(1));
                      setFollowingActors((actors) => {
                        const s = new Set(actors);
                        s.add(actor.id);
                        return s;
                      });
                      fetch(
                        actor.accountId == null
                          ? `/${actor.handle}/follow`
                          : `/@${actor.username}/follow`,
                        {
                          method: "POST",
                        },
                      ).then(() => {
                        setShownActors((actors) => [
                          ...actors.slice(0, index),
                          ...hiddenActors.slice(0, 1),
                          ...actors.slice(index + 1),
                        ]);
                        setFollowingActors((actors) => {
                          const s = new Set(actors);
                          s.delete(actor.id);
                          return s;
                        });
                      });
                    }}
                  >
                    {followingActors.has(actor.id)
                      ? <Msg $key="recommendedActors.following" />
                      : <Msg $key="recommendedActors.follow" />}
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </Translation>
    </TranslationSetup>
  );
}

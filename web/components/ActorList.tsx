import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { preprocessContentHtml } from "@hackerspub/models/html";
import type { Account, Actor } from "@hackerspub/models/schema";
import { escape } from "@std/html/entities";
import type { ComponentChildren } from "preact";
import { Link } from "../islands/Link.tsx";
import { Msg } from "./Msg.tsx";

export interface ActorListProps {
  actors: (Actor & { account?: Account | null })[];
  actorMentions: { actor: Actor }[];
  nextUrl?: string;
  rightTopButton?: (
    actor: Actor & { account?: Account | null },
  ) => ComponentChildren;
  class?: string;
}

export function ActorList(
  { actors, actorMentions, nextUrl, rightTopButton, class: cls }:
    ActorListProps,
) {
  return (
    <div
      class={`
        grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4
        ${cls ?? ""}
      `}
    >
      {actors.map((actor) => (
        <div
          key={actor.id}
          class="bg-stone-100 dark:bg-stone-800 p-4 flex flex-col h-full"
        >
          <div class="flex space-x-4">
            <img
              src={actor.avatarUrl ??
                "https://gravatar.com/avatar/?d=mp&s=128"}
              alt={actor.name ?? undefined}
              class="w-12 h-12 shrink-0"
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
            {rightTopButton && rightTopButton(actor)}
          </div>
          <div
            class="mt-4 prose dark:prose-invert"
            dangerouslySetInnerHTML={{
              __html: preprocessContentHtml(
                actor.bioHtml ?? "",
                {
                  mentions: actorMentions,
                  emojis: actor.emojis,
                  tags: actor.tags,
                },
              ),
            }}
          />
        </div>
      ))}
      {nextUrl &&
        (
          <a
            href={nextUrl}
            rel="next"
            class="bg-stone-100 dark:bg-stone-800 p-4 h-full flex flex-col items-center justify-center group"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="size-6 opacity-50 group-hover:opacity-100"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m5.25 4.5 7.5 7.5-7.5 7.5m6-15 7.5 7.5-7.5 7.5"
              />
            </svg>
            <span class="mt-2 opacity-50 group-hover:opacity-100">
              <Msg $key="actorList.seeMore" />
            </span>
          </a>
        )}
    </div>
  );
}

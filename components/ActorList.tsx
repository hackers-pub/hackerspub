import { Link } from "../islands/Link.tsx";
import { renderCustomEmojis } from "../models/emoji.ts";
import type { Account, Actor } from "../models/schema.ts";
import { htmlXss } from "../models/xss.ts";

export interface ActorListProps {
  actors: (Actor & { account?: Account | null })[];
}

export function ActorList({ actors }: ActorListProps) {
  return (
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {actors.map((actor) => (
        <div
          key={actor.id}
          class="bg-white dark:bg-stone-800 p-4 flex flex-col h-full"
        >
          <div class="flex items-center space-x-4">
            <img
              src={actor.avatarUrl ??
                "https://gravatar.com/avatar/?d=mp&s=128"}
              alt={actor.name ?? undefined}
              class="w-12 h-12"
            />
            <div>
              <h2 class="text-lg font-semibold">
                <Link
                  internalHref={actor.accountId == null
                    ? `/@${actor.username}@${actor.instanceHost}`
                    : `/@${actor.username}`}
                  href={actor.url ?? actor.iri}
                >
                  {actor.name ?? actor.username}
                </Link>
              </h2>
              <p class="text-stone-500">
                <Link
                  internalHref={actor.accountId == null
                    ? `/@${actor.username}@${actor.instanceHost}`
                    : `/@${actor.username}`}
                  href={actor.url ?? actor.iri}
                  class="select-all"
                >
                  @{actor.username}@{actor.instanceHost}
                </Link>
              </p>
            </div>
          </div>
          <div
            class="mt-4 prose dark:prose-invert"
            dangerouslySetInnerHTML={{
              __html: renderCustomEmojis(
                htmlXss.process(actor.bioHtml ?? ""),
                actor.emojis,
              ),
            }}
          />
        </div>
      ))}
    </div>
  );
}

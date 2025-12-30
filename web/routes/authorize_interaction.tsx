import { isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { page } from "@fresh/core";
import { persistActor } from "@hackerspub/models/actor";
import type { Actor, Instance } from "@hackerspub/models/schema";
import { getLogger } from "@logtape/logtape";
import { Button } from "../components/Button.tsx";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { db } from "../db.ts";
import { define } from "../utils.ts";

const logger = getLogger(["hackerspub", "routes", "authorize_interaction"]);

export const handler = define.handlers({
  async GET(ctx) {
    const uri = ctx.url.searchParams.get("uri");

    // If user is not logged in, redirect to sign-in page
    if (!ctx.state.account) {
      const fromUrl = ctx.url.pathname + ctx.url.search;
      const from = fromUrl.startsWith("/") && !fromUrl.startsWith("//")
        ? fromUrl
        : "/";
      return ctx.redirect(`/sign?from=${encodeURIComponent(from)}`);
    }

    let actor: (Actor & { instance: Instance }) | null = null;

    if (uri) {
      // Try to find actor in database first
      const foundActor = await db.query.actorTable.findFirst({
        where: { OR: [{ iri: uri }, { url: uri }] },
        with: { instance: true },
      });
      actor = foundActor ?? null;

      // If not found, try to fetch from remote
      if (actor == null) {
        const documentLoader = await ctx.state.fedCtx.getDocumentLoader({
          identifier: ctx.state.account.id,
        });
        let object: vocab.Object | null;
        try {
          object = await ctx.state.fedCtx.lookupObject(uri, {
            documentLoader,
          });
        } catch (error) {
          logger.error("Failed to lookup object", { uri, err: error });
          object = null;
        }

        if (object != null && isActor(object)) {
          const persistedActor = await persistActor(ctx.state.fedCtx, object, {
            contextLoader: ctx.state.fedCtx.contextLoader,
            documentLoader,
            outbox: false,
          });

          if (persistedActor != null) {
            actor = persistedActor;
          }
        }
      }
    }

    return page<AuthorizedInteractionProps>({ uri, actor });
  },
});

export interface AuthorizedInteractionProps {
  uri: string | null;
  actor: (Actor & { instance: Instance }) | null;
}

export default define.page<typeof handler, AuthorizedInteractionProps>(
  function AuthorizedInteraction({ state, data }) {
    const { uri, actor } = data;

    if (!uri) {
      return (
        <div>
          <PageTitle>
            <Msg $key="authorizedInteraction.title" />
          </PageTitle>
          <div class="prose dark:prose-invert max-w-2xl">
            <p class="text-red-500">
              <Msg $key="authorizedInteraction.noUri" />
            </p>
          </div>
        </div>
      );
    }

    return (
      <div>
        <PageTitle>
          <Msg $key="authorizedInteraction.title" />
        </PageTitle>
        <div class="max-w-2xl">
          <div class="bg-white dark:bg-stone-800 rounded-lg p-6 border border-gray-200 dark:border-stone-700">
            <div class="mb-4">
              <h2 class="text-lg font-semibold mb-2">
                <Msg $key="authorizedInteraction.subtitle" />
              </h2>
              <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
                <Msg
                  $key="authorizedInteraction.description"
                  uri={actor?.name || actor?.handle || uri}
                />
              </p>
            </div>

            {actor && (
              <div class="bg-gray-50 dark:bg-stone-700 rounded-md p-4 mb-4">
                <div class="flex items-start gap-3">
                  {actor.avatarUrl && (
                    <img
                      src={actor.avatarUrl}
                      alt={actor.name || actor.handle}
                      class="w-12 h-12 rounded-full flex-shrink-0"
                    />
                  )}
                  <div class="flex-1 min-w-0">
                    {actor.name && (
                      <h3 class="font-semibold text-gray-900 dark:text-gray-100 truncate">
                        {actor.name}
                      </h3>
                    )}
                    <p class="text-sm text-gray-600 dark:text-gray-400 truncate">
                      {actor.handle}
                    </p>
                    {actor.instance && (
                      <p class="text-xs text-gray-500 dark:text-gray-500 mt-1">
                        {actor.instance.host}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!actor && (
              <div class="bg-gray-50 dark:bg-stone-700 rounded-md p-4 mb-4">
                <div class="flex items-center gap-2">
                  <code class="text-sm break-all">{uri}</code>
                </div>
              </div>
            )}

            <div class="space-y-3">
              <p class="text-sm text-gray-600 dark:text-gray-300">
                <Msg $key="authorizedInteraction.loggedInAs" />{" "}
                <strong>@{state.account!.username}</strong>
              </p>

              <div class="flex gap-3">
                <form
                  action={actor?.url ?? "/"}
                  method="GET"
                  class="flex-1"
                >
                  <Button type="submit" class="w-full">
                    <Msg $key="authorizedInteraction.cancel" />
                  </Button>
                </form>
                {actor
                  ? (
                    <form
                      action={`/${actor.handle}/follow`}
                      method="POST"
                      class="flex-1"
                    >
                      <Button
                        type="submit"
                        class="w-full"
                      >
                        <Msg $key="authorizedInteraction.followButton" />
                      </Button>
                    </form>
                  )
                  : (
                    <Button
                      type="button"
                      disabled
                      class="flex-1 opacity-50 cursor-not-allowed"
                    >
                      <Msg $key="authorizedInteraction.followButton" />
                    </Button>
                  )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

import { useSentry } from "@envelop/sentry";
import type {
  Account,
  AccountEmail,
  AccountLink,
  Actor,
  Medium,
} from "@hackerspub/models/schema";
import { getSession } from "@hackerspub/models/session";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import * as Sentry from "@sentry/deno";
import { getCookies } from "@std/http/cookie";
import { execute } from "graphql";
import {
  createYoga,
  type Plugin as EnvelopPlugin,
  type YogaServerInstance,
} from "graphql-yoga";
import type { ServerContext, UserContext } from "./builder.ts";
import { schema as graphqlSchema } from "./mod.ts";
import { useQuerySnapshotTransaction } from "./query-tx-plugin.ts";

const sentryEnabled = Deno.env.get("SENTRY_DSN") != null;

export function createYogaServer(): YogaServerInstance<
  ServerContext,
  UserContext
> {
  return createYoga({
    schema: graphqlSchema,
    context: async (ctx) => {
      const { request: req, db, kv } = ctx;
      let sessionId: Uuid | undefined = undefined;
      const authorization = req.headers.get("Authorization");
      if (authorization && authorization.startsWith("Bearer ")) {
        const uuid = authorization.slice(7).trim();
        if (validateUuid(uuid)) sessionId = uuid;
      }
      if (sessionId == null) {
        const cookies = getCookies(req.headers);
        if (validateUuid(cookies.session)) sessionId = cookies.session;
      }

      let session = sessionId == null
        ? undefined
        : await getSession(kv, sessionId);
      let account:
        | Account & {
          actor: Actor;
          avatarMedium: Medium | null;
          emails: AccountEmail[];
          links: AccountLink[];
        }
        | undefined;

      if (session != null) {
        account = await db.query.accountTable.findFirst({
          where: { id: session.accountId },
          with: {
            actor: true,
            avatarMedium: true,
            emails: true,
            links: true,
          },
        });
        if (account == null) session = undefined;
      }

      // Tag the per-request Sentry isolation scope with the signed-in user
      // so any exception captured downstream (envelop's `useSentry` plugin
      // for resolver errors, the LogTape sentry sink for `error`/`fatal`
      // logs, default integrations for unhandled throws) carries user
      // identity. `denoServeIntegration` (default in @sentry/deno) forks an
      // isolation scope per request via `withIsolationScope`, and
      // `Sentry.setUser` writes to that isolation scope — so this does NOT
      // leak across concurrent requests, and unlike mutating the active
      // scope inside envelop's `configureScope` callback, it survives the
      // plugin's `withScope` clones used at error-capture time.
      if (sentryEnabled && account != null) {
        const verifiedEmail = account.emails.find(
          (e) => e.verified != null,
        )?.email;
        Sentry.setUser({
          id: account.id,
          username: account.username,
          ...(verifiedEmail == null ? {} : { email: verifiedEmail }),
        });
      }

      return {
        session,
        account,
        ...ctx,
      };
    },
    plugins: [
      // graphql@canary-pr-4364 (which we pin for the onError execution
      // argument used by the NO_PROPAGATE plugin below) adds two things to
      // schema introspection that do not exist in any stable graphql release:
      //
      //  • __ErrorBehavior — an enum type exposed in the flat `types` list
      //  • defaultErrorBehavior — a field on the built-in __Schema type
      //
      // GraphiQL bundles a stable graphql release. When it receives the
      // introspection response it calls buildClientSchema, which validates
      // every type name. The stable library does not recognise __ErrorBehavior
      // and throws "Name must not begin with '__'" for it, crashing the entire
      // GraphiQL UI before any query can be written.
      //
      // This plugin intercepts introspection responses and removes both
      // additions before they reach the client. It is safe to do so because:
      //  • __ErrorBehavior is an implementation detail of the canary build; no
      //    part of the application schema refers to it as a user-visible type.
      //  • The actual NO_PROPAGATE/PROPAGATE behaviour is wired at execution
      //    time via the onError argument — not via schema introspection — so
      //    stripping it from the introspection payload has no runtime effect.
      {
        onExecute: () => ({
          // deno-lint-ignore no-explicit-any
          onExecuteDone: ({ result, setResult }: any) => {
            // Subscriptions return an AsyncIterableIterator; introspection
            // queries never do, so we can skip the streaming case entirely.
            if (Symbol.asyncIterator in result) return;

            const schemaPayload = result.data?.__schema as
              | Record<string, unknown>
              | null
              | undefined;
            if (schemaPayload == null) return; // not an introspection response

            let types = schemaPayload.types as
              | Array<Record<string, unknown>>
              | undefined;
            if (!Array.isArray(types)) return;

            // 1. Remove __ErrorBehavior from the flat type registry. Without
            //    this step buildClientSchema would encounter the type name and
            //    throw immediately.
            types = types.filter((t) => t.name !== "__ErrorBehavior");

            // 2. Remove defaultErrorBehavior from __Schema's own field list.
            //    Even after step 1 the field entry still references
            //    __ErrorBehavior as its return type; buildClientSchema would
            //    try to resolve that type reference and fail because the type
            //    is no longer in the registry.
            types = types.map((t) => {
              if (t.name !== "__Schema") return t;
              const fields = t.fields as
                | Array<Record<string, unknown>>
                | undefined;
              if (!Array.isArray(fields)) return t;
              return {
                ...t,
                fields: fields.filter((f) => f.name !== "defaultErrorBehavior"),
              };
            });

            // 3. Remove the @behavior directive from the directives list.
            //    The canary build adds @behavior (locations: [SCHEMA]) with a
            //    single argument `onError: __ErrorBehavior!`. Even though we
            //    removed __ErrorBehavior from the types list above, @behavior's
            //    argument still carries a type reference to it; buildClientSchema
            //    would try to resolve that reference and fail with "unknown type:
            //    __ErrorBehavior".
            const directives = schemaPayload.directives as
              | Array<Record<string, unknown>>
              | undefined;
            const filteredDirectives = Array.isArray(directives)
              ? directives.filter((d) => d.name !== "behavior")
              : directives;

            setResult({
              ...result,
              data: {
                ...result.data,
                __schema: {
                  ...schemaPayload,
                  types,
                  ...(filteredDirectives !== directives
                    ? { directives: filteredDirectives }
                    : {}),
                },
              },
            });
          },
        }),
      } as EnvelopPlugin,
      {
        onExecute: ({ setExecuteFn, context }) => {
          const isNoPropagate =
            new URL(context.request.url).searchParams.get("no-propagate") ===
              "true" ||
            context.request.headers.get("x-no-propagate") === "true";
          setExecuteFn((args) =>
            execute({
              ...args,
              onError: isNoPropagate ? "NO_PROPAGATE" : "PROPAGATE",
            })
          );
        },
      } as EnvelopPlugin,
      // Wrap query operations in a REPEATABLE READ transaction so Pothos
      // drizzle's re-fetches see the same snapshot the timeline resolvers
      // used.  Must come after the NO_PROPAGATE wrapper above so the
      // transaction layers on top of the configured executeFn.
      useQuerySnapshotTransaction(),
      // Capture unhandled resolver exceptions in Sentry. Yoga otherwise
      // catches throws and folds them into the response `errors[]`, so
      // they never bubble up to the HTTP boundary where the SDK's default
      // integrations would see them. Pothos's ErrorsPlugin-handled errors
      // (declared `errors.types`) are already converted to result unions
      // before this point, so they don't show up as `errors[]` either.
      // The plugin's default `skipError` (`isOriginalGraphQLError`) skips
      // intentionally-thrown GraphQLErrors (validation, not-found, …) and
      // only reports errors whose `originalError` is a real exception.
      ...(sentryEnabled ? [useSentry()] : []),
    ],
  });
}

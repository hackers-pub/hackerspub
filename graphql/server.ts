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

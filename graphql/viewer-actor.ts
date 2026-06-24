import {
  OrganizationPermissionError,
  resolveActingAccount,
} from "@hackerspub/models/organization";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { decodeGlobalID } from "@pothos/plugin-relay";
import { createGraphQLError } from "graphql-yoga";
import type { UserContext } from "./builder.ts";

export const actingAccountIdArgDescription =
  "Optional `Account` ID that changes viewer-relative checks to an " +
  "organization account managed by the authenticated viewer. Omit this " +
  "argument to use the authenticated viewer's personal account.";

export interface ActingAccountIdArg {
  actingAccountId?: { id: string; typename?: string } | string | null;
}

const viewerActorIdCache = new WeakMap<
  UserContext,
  Map<string, Promise<Uuid | null>>
>();

export async function resolveViewerActorId(
  ctx: UserContext,
  { actingAccountId }: ActingAccountIdArg,
): Promise<Uuid | null> {
  const cacheKey = typeof actingAccountId === "string"
    ? actingAccountId
    : actingAccountId?.id ?? "";
  let cache = viewerActorIdCache.get(ctx);
  if (cache == null) {
    cache = new Map();
    viewerActorIdCache.set(ctx, cache);
  }
  let promise = cache.get(cacheKey);
  if (promise == null) {
    promise = resolveViewerActorIdUncached(ctx, { actingAccountId });
    cache.set(cacheKey, promise);
  }
  return await promise;
}

async function resolveViewerActorIdUncached(
  ctx: UserContext,
  { actingAccountId }: ActingAccountIdArg,
): Promise<Uuid | null> {
  if (ctx.account?.actor == null) return null;
  const rawAccountId = normalizeActingAccountId(actingAccountId);
  try {
    const account = await resolveActingAccount(
      ctx.db,
      ctx.account,
      rawAccountId as Uuid | undefined,
    );
    return account.actor.id;
  } catch (error) {
    if (error instanceof OrganizationPermissionError) {
      throw createGraphQLError("Not allowed to use this acting account.", {
        originalError: error,
        extensions: { code: "FORBIDDEN" },
      });
    }
    throw error;
  }
}

function normalizeActingAccountId(
  value: ActingAccountIdArg["actingAccountId"],
): Uuid | undefined {
  if (value == null) return undefined;
  let id: unknown;
  let typename: unknown;
  if (typeof value === "string") {
    try {
      ({ id, typename } = decodeGlobalID(value));
    } catch (error) {
      throw createGraphQLError("Invalid acting account.", {
        originalError: error instanceof Error ? error : undefined,
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
  } else {
    id = value.id;
    typename = value.typename;
  }
  if (typename != null && typename !== "Account") {
    throw createGraphQLError("Invalid acting account.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (typeof id !== "string" || !validateUuid(id)) {
    throw createGraphQLError("Invalid acting account.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return id as Uuid;
}

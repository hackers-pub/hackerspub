import { decodeGlobalID } from "@pothos/plugin-relay";
import { resolveActingAccount } from "@hackerspub/models/organization";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import type { UserContext } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

type ActingAccount = NonNullable<UserContext["account"]>;

interface ActingAccountInput {
  actingAccountId?: { id: string; typename?: string } | null;
}

export async function resolveActingAccountForMutation(
  ctx: UserContext,
  input: ActingAccountInput,
): Promise<ActingAccount> {
  if (ctx.account == null) throw new NotAuthenticatedError();
  const actingAccountId = input.actingAccountId;
  if (
    actingAccountId?.typename != null &&
    actingAccountId.typename !== "Account"
  ) {
    throw new InvalidInputError("actingAccountId");
  }
  const accountId = actingAccountId?.id;
  if (accountId != null && !validateUuid(accountId)) {
    throw new InvalidInputError("actingAccountId");
  }
  const account = await resolveActingAccount(
    ctx.db,
    ctx.account,
    accountId,
  );
  return account as ActingAccount;
}

interface ActingAccountGlobalIdInput {
  actingAccountId?: { id: unknown; typename?: string } | string | null;
}

export async function resolveActingAccountForGlobalIdArg(
  ctx: UserContext,
  input: ActingAccountGlobalIdInput,
): Promise<ActingAccount> {
  const actingAccountId = input.actingAccountId;
  if (actingAccountId == null) {
    return await resolveActingAccountForMutation(ctx, {
      actingAccountId: null,
    });
  }
  let id: unknown;
  let typename: unknown;
  if (typeof actingAccountId === "string") {
    try {
      ({ id, typename } = decodeGlobalID(actingAccountId));
    } catch {
      throw new InvalidInputError("actingAccountId");
    }
  } else {
    id = actingAccountId.id;
    typename = actingAccountId.typename;
  }
  if (
    typename != null &&
    typename !== "Account"
  ) {
    throw new InvalidInputError("actingAccountId");
  }
  if (typeof id !== "string" || !validateUuid(id)) {
    throw new InvalidInputError("actingAccountId");
  }
  return await resolveActingAccountForMutation(ctx, {
    actingAccountId: {
      id: id as Uuid,
      typename: typeof typename === "string" ? typename : undefined,
    },
  });
}

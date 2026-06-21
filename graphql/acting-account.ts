import { resolveActingAccount } from "@hackerspub/models/organization";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import type { UserContext } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

type ActingAccount = NonNullable<UserContext["account"]>;

interface ActingAccountInput {
  actingAccountId?: { id: string } | null;
}

export async function resolveActingAccountForMutation(
  ctx: UserContext,
  input: ActingAccountInput,
): Promise<ActingAccount> {
  if (ctx.account == null) throw new NotAuthenticatedError();
  const actingAccountId = input.actingAccountId?.id;
  if (actingAccountId != null && !validateUuid(actingAccountId)) {
    throw new InvalidInputError("actingAccountId");
  }
  const account = await resolveActingAccount(
    ctx.db,
    ctx.account,
    actingAccountId as Uuid | undefined,
  );
  return account as ActingAccount;
}

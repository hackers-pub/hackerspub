import { getLogger } from "@logtape/logtape";
import { encodeBase64Url } from "@std/encoding/base64url";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  Account,
  accountEmailTable,
  accountTable,
  NewAccount,
} from "./schema.ts";
import { Database } from "../db.ts";

const logger = getLogger(["hackerspub", "models", "signup"]);

const KV_NAMESPACE = ["signup"];

export const EXPIRATION = Temporal.Duration.from({ days: 1 });

export interface SignupToken {
  email: string;
  token: string;
  code: string;
  created: Date;
}

export async function createSignupToken(
  kv: Deno.Kv,
  email: string,
): Promise<SignupToken> {
  const token = crypto.randomUUID();
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  const tokenData: SignupToken = {
    email,
    token,
    code: encodeBase64Url(buffer),
    created: new Date(),
  };
  await kv.set(
    [...KV_NAMESPACE, token],
    tokenData,
    { expireIn: EXPIRATION.total("millisecond") },
  );
  logger.debug("Created sign-up token (expires in {expires}): {token}", {
    expires: EXPIRATION,
    token: tokenData,
  });
  return tokenData;
}

export async function getSignupToken(
  kv: Deno.Kv,
  token: string,
): Promise<SignupToken | undefined> {
  const result = await kv.get<SignupToken>([...KV_NAMESPACE, token]);
  return result.value ?? undefined;
}

export async function deleteSignupToken(
  kv: Deno.Kv,
  token: string,
): Promise<void> {
  await kv.delete([...KV_NAMESPACE, token]);
}

export async function createAccount(
  db: Database,
  token: SignupToken,
  account: Omit<NewAccount, "id"> & Pick<Partial<NewAccount>, "id">,
): Promise<Account | undefined> {
  const accounts = await db.insert(accountTable).values({
    ...account,
    id: account.id ?? uuidv7(),
  })
    .returning();
  if (accounts.length !== 1) {
    logger.error("Failed to create account: {account}", { account });
    return undefined;
  }
  await db.insert(accountEmailTable).values(
    {
      email: token.email,
      accountId: accounts[0].id,
      public: false,
      verified: sql`CURRENT_TIMESTAMP`,
    },
  );
  return accounts[0];
}

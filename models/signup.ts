import { getLogger } from "@logtape/logtape";
import { encodeBase64Url } from "@std/encoding/base64url";
import { sql } from "drizzle-orm";
import type Keyv from "keyv";
import type { Database } from "../db.ts";
import {
  type Account,
  type AccountEmail,
  accountEmailTable,
  accountTable,
  type NewAccount,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "signup"]);

const KV_NAMESPACE = "signup";

export const EXPIRATION = Temporal.Duration.from({ hours: 12 });

export interface SignupToken {
  email: string;
  token: Uuid;
  code: string;
  created: Date;
}

export async function createSignupToken(
  kv: Keyv,
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
    `${KV_NAMESPACE}/${token}`,
    tokenData,
    EXPIRATION.total("millisecond"),
  );
  logger.debug("Created sign-up token (expires in {expires}): {token}", {
    expires: EXPIRATION,
    token: tokenData,
  });
  return tokenData;
}

export function getSignupToken(
  kv: Keyv,
  token: Uuid,
): Promise<SignupToken | undefined> {
  return kv.get<SignupToken>(`${KV_NAMESPACE}/${token}`);
}

export async function deleteSignupToken(
  kv: Keyv,
  token: Uuid,
): Promise<void> {
  await kv.delete(`${KV_NAMESPACE}/${token}`);
}

export async function createAccount(
  db: Database,
  token: SignupToken,
  account: Omit<NewAccount, "id"> & Pick<Partial<NewAccount>, "id">,
): Promise<Account & { emails: AccountEmail[] } | undefined> {
  const accounts = await db.insert(accountTable).values({
    ...account,
    id: account.id ?? generateUuidV7(),
  })
    .returning();
  if (accounts.length !== 1) {
    logger.error("Failed to create account: {account}", { account });
    return undefined;
  }
  const emails = await db.insert(accountEmailTable).values(
    {
      email: token.email,
      accountId: accounts[0].id,
      public: false,
      verified: sql`CURRENT_TIMESTAMP`,
    },
  ).returning();
  return { ...accounts[0], emails };
}

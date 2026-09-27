import { getLogger } from "@logtape/logtape";
import { encodeBase64Url } from "@std/encoding/base64url";
import { sql } from "drizzle-orm";
import type Keyv from "keyv";
import type { Database, Transaction } from "./db.ts";
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

export const EXPIRATION: Temporal.Duration = Temporal.Duration.from({
  hours: 12,
});

export interface SignupToken {
  email: string;
  token: Uuid;
  code: string;
  inviterId?: Uuid;
  created: Date;
}

export interface CreateSignupTokenOptions {
  inviterId?: Uuid;
  expiration?: Temporal.DurationLike;
}

export async function createSignupToken(
  kv: Keyv,
  email: string,
  options: CreateSignupTokenOptions = {},
): Promise<SignupToken> {
  const token = crypto.randomUUID();
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  const tokenData: SignupToken = {
    email,
    token,
    code: encodeBase64Url(buffer),
    inviterId: options.inviterId,
    created: new Date(),
  };
  const expiration =
    options.expiration == null
      ? EXPIRATION
      : Temporal.Duration.from(options.expiration);
  await kv.set(
    `${KV_NAMESPACE}/${token}`,
    tokenData,
    expiration.total("millisecond"),
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

export async function deleteSignupToken(kv: Keyv, token: Uuid): Promise<void> {
  await kv.delete(`${KV_NAMESPACE}/${token}`);
}

export async function createAccount(
  db: Database | Transaction,
  token: SignupToken,
  account: Omit<NewAccount, "id"> & Pick<Partial<NewAccount>, "id">,
): Promise<(Account & { emails: AccountEmail[] }) | undefined> {
  return await db.transaction(async (tx) => {
    const accounts = await tx
      .insert(accountTable)
      .values({
        ...account,
        id: account.id ?? generateUuidV7(),
        inviterId: token.inviterId,
      })
      .returning();
    if (accounts.length !== 1) {
      logger.error("Failed to create account: {account}", { account });
      return undefined;
    }
    const emails = await tx
      .insert(accountEmailTable)
      .values({
        email: token.email,
        accountId: accounts[0].id,
        public: false,
        primary: true,
        verified: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoNothing()
      .returning();
    if (emails.length === 0) throw new EmailAlreadyRegisteredError();
    return { ...accounts[0], emails };
  });
}

export class EmailAlreadyRegisteredError extends Error {}

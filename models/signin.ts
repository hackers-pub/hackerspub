import { getLogger } from "@logtape/logtape";
import type Keyv from "keyv";
import { eq } from "drizzle-orm";
import { type Database, type Transaction, runInTransaction } from "./db.ts";
import { accountTable } from "./schema.ts";
import { USERNAME_REGEXP } from "./userValidation.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "signin"]);

const KV_NAMESPACE = "signin";

export const EXPIRATION: Temporal.Duration = Temporal.Duration.from({
  hours: 12,
});

export { USERNAME_REGEXP };

export class EmailLoginUnavailableError extends Error {
  constructor() {
    super("The account has no verified email address for sign-in.");
  }
}

export interface SigninToken {
  accountId: Uuid;
  token: Uuid;
  code: string;
  created: Date;
  emails?: string[];
  emailCredentialsChanged?: number | null;
}

export async function createSigninToken(
  kv: Keyv,
  accountId: Uuid,
  emails?: string[],
  emailCredentialsChanged?: number | null,
): Promise<SigninToken> {
  const token = crypto.randomUUID();
  const tokenData: SigninToken = {
    accountId,
    emails,
    emailCredentialsChanged,
    token,
    code: generateTokenCode(),
    created: new Date(),
  };
  await kv.set(
    `${KV_NAMESPACE}/${token}`,
    tokenData,
    EXPIRATION.total("millisecond"),
  );
  logger.debug("Created sign-in token for {accountId} (expires in {expires})", {
    expires: EXPIRATION,
    accountId,
  });
  return tokenData;
}

/** Capture verified recipients and issue the token under the revocation lock. */
export async function createEmailSigninToken(
  db: Database | Transaction,
  kv: Keyv,
  accountId: Uuid,
  requestedEmail?: string,
): Promise<
  (SigninToken & { emails: string[]; emailLoginEnabled: boolean }) | undefined
> {
  return await runInTransaction(db, async (tx) => {
    await tx
      .select({ id: accountTable.id })
      .from(accountTable)
      .where(eq(accountTable.id, accountId))
      .for("update");
    const account = await tx.query.accountTable.findFirst({
      where: { id: accountId, kind: "personal" },
      with: { emails: true },
    });
    if (account == null) return undefined;
    const emails = account.emails
      .filter(
        (item) =>
          item.verified != null &&
          (requestedEmail == null ||
            item.email.toLowerCase() === requestedEmail.toLowerCase()),
      )
      .map((item) => item.email);
    if (emails.length === 0) {
      if (requestedEmail == null) throw new EmailLoginUnavailableError();
      return undefined;
    }
    if (!account.emailLoginEnabled) {
      // An indistinguishable challenge is returned, but cannot authenticate.
      return {
        accountId,
        emails,
        token: crypto.randomUUID(),
        code: "",
        created: new Date(),
        emailLoginEnabled: false,
      };
    }
    const token = await createSigninToken(
      kv,
      accountId,
      emails,
      account.emailCredentialsChanged?.getTime() ?? null,
    );
    return { ...token, emails, emailLoginEnabled: true };
  });
}

export function getSigninToken(
  kv: Keyv,
  token: Uuid,
): Promise<SigninToken | undefined> {
  return kv.get<SigninToken>(`${KV_NAMESPACE}/${token}`);
}

export async function deleteSigninToken(kv: Keyv, token: Uuid): Promise<void> {
  await kv.delete(`${KV_NAMESPACE}/${token}`);
}

function generateTokenCode(): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const buffer = new Uint8Array(6);
  crypto.getRandomValues(buffer);
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[buffer[i] % chars.length];
  }
  return result;
}

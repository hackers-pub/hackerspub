import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "./account.ts";
import { type Database, runInTransaction, type Transaction } from "./db.ts";
import {
  accountEmailChallengeTable,
  accountEmailTable,
  accountTable,
  type Account,
  type AccountEmail,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export const EMAIL_LIMIT = 5;
export const AccountEmailErrorCode = {
  INVALID_EMAIL: "INVALID_EMAIL",
  UNAVAILABLE: "UNAVAILABLE",
  ALREADY_REGISTERED: "ALREADY_REGISTERED",
  NOT_FOUND: "NOT_FOUND",
  UNVERIFIED: "UNVERIFIED",
  LIMIT_REACHED: "LIMIT_REACHED",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_CODE: "INVALID_CODE",
  REAUTHENTICATION_REQUIRED: "REAUTHENTICATION_REQUIRED",
  PRIMARY_EMAIL: "PRIMARY_EMAIL",
  LAST_EMAIL: "LAST_EMAIL",
  DELIVERY_FAILED: "DELIVERY_FAILED",
} as const;
export type AccountEmailErrorCode =
  (typeof AccountEmailErrorCode)[keyof typeof AccountEmailErrorCode];
export class AccountEmailError extends Error {
  readonly code: AccountEmailErrorCode;
  readonly retryAfter: number | undefined;
  constructor(code: AccountEmailErrorCode, retryAfter?: number) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface EmailChange {
  account: Account;
  previousEmails: AccountEmail[];
  emails: AccountEmail[];
  primaryChanged: boolean;
}
export interface EmailVerificationChallenge {
  token: Uuid;
  code: string;
  email: string;
  expires: Date;
}

function hashCode(token: Uuid, code: string): string {
  return createHash("sha256").update(`${token}:${code}`).digest("hex");
}

async function lockAccount(
  db: Transaction,
  accountId: Uuid,
): Promise<Account | undefined> {
  const [account] = await db
    .select()
    .from(accountTable)
    .where(eq(accountTable.id, accountId))
    .for("update");
  return account?.kind === "personal" ? account : undefined;
}

export function findAccountEmail(
  db: Database | Transaction,
  email: string,
): Promise<AccountEmail | undefined> {
  return db
    .select()
    .from(accountEmailTable)
    .where(sql`lower(${accountEmailTable.email}) = lower(${email})`)
    .limit(1)
    .then((rows) => rows[0]);
}

export async function requestEmailVerification(
  db: Database | Transaction,
  accountId: Uuid,
  sessionId: Uuid,
  address: string,
  now = new Date(),
): Promise<EmailVerificationChallenge | AccountEmailError> {
  let email: string;
  try {
    email = normalizeEmail(address);
    if (email.length > 254 || /[\s\p{Cc}<>(),;:"\\]/u.test(email))
      throw new TypeError();
  } catch {
    return new AccountEmailError("INVALID_EMAIL");
  }
  return await runInTransaction(db, async (tx) => {
    if ((await lockAccount(tx, accountId)) == null)
      return new AccountEmailError("NOT_FOUND");
    // All accounts requesting the same recipient share the rate-limit lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(lower(${email}), 416))`,
    );
    const existing = await findAccountEmail(tx, email);
    if (existing != null && existing.accountId !== accountId)
      return new AccountEmailError("UNAVAILABLE");
    if (existing?.verified != null)
      return new AccountEmailError("ALREADY_REGISTERED");
    const emails = await tx
      .select()
      .from(accountEmailTable)
      .where(
        and(
          eq(accountEmailTable.accountId, accountId),
          isNotNull(accountEmailTable.verified),
        ),
      );
    if (emails.length >= EMAIL_LIMIT)
      return new AccountEmailError("LIMIT_REACHED");
    const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const hour = new Date(now.getTime() - 60 * 60 * 1000);
    await tx
      .delete(accountEmailChallengeTable)
      .where(
        and(
          eq(accountEmailChallengeTable.accountId, accountId),
          lt(accountEmailChallengeTable.created, day),
        ),
      );
    const accountRequests = await tx
      .select({ created: accountEmailChallengeTable.created })
      .from(accountEmailChallengeTable)
      .where(
        and(
          eq(accountEmailChallengeTable.accountId, accountId),
          gt(accountEmailChallengeTable.created, day),
        ),
      )
      .orderBy(accountEmailChallengeTable.created);
    const recipientRequests = await tx
      .select({ created: accountEmailChallengeTable.created })
      .from(accountEmailChallengeTable)
      .where(
        and(
          sql`lower(${accountEmailChallengeTable.email}) = lower(${email})`,
          gt(accountEmailChallengeTable.created, day),
        ),
      )
      .orderBy(accountEmailChallengeTable.created);
    const recent = accountRequests.at(-1);
    let retryAfter =
      recent == null
        ? 0
        : 60 - Math.floor((now.getTime() - recent.created.getTime()) / 1000);
    if (accountRequests.length >= 10)
      retryAfter = Math.max(
        retryAfter,
        Math.ceil(
          (accountRequests[0].created.getTime() + 86400000 - now.getTime()) /
            1000,
        ),
      );
    if (recipientRequests.length >= 10)
      retryAfter = Math.max(
        retryAfter,
        Math.ceil(
          (recipientRequests[0].created.getTime() + 86400000 - now.getTime()) /
            1000,
        ),
      );
    const hourly = recipientRequests.filter(
      (request) => request.created > hour,
    );
    if (hourly.length >= 3)
      retryAfter = Math.max(
        retryAfter,
        Math.ceil(
          (hourly[0].created.getTime() + 3600000 - now.getTime()) / 1000,
        ),
      );
    if (retryAfter > 0)
      return new AccountEmailError("RATE_LIMITED", retryAfter);
    await tx
      .update(accountEmailChallengeTable)
      .set({ used: true })
      .where(eq(accountEmailChallengeTable.accountId, accountId));
    const token = crypto.randomUUID();
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = Array.from(
      { length: 8 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    const expires = new Date(now.getTime() + 15 * 60 * 1000);
    await tx.insert(accountEmailChallengeTable).values({
      token,
      accountId,
      sessionId,
      email,
      codeHash: hashCode(token, code),
      expires,
      created: now,
    });
    return { token, code, email, expires };
  });
}

export async function invalidateEmailVerification(
  db: Database | Transaction,
  token: Uuid,
): Promise<void> {
  await db
    .update(accountEmailChallengeTable)
    .set({ used: true })
    .where(eq(accountEmailChallengeTable.token, token));
}

async function changed(
  tx: Transaction,
  account: Account,
  previousEmails: AccountEmail[],
  now: Date,
): Promise<EmailChange> {
  const emails = await tx
    .select()
    .from(accountEmailTable)
    .where(eq(accountEmailTable.accountId, account.id));
  const [updated] = await tx
    .update(accountTable)
    .set({ updated: now })
    .where(eq(accountTable.id, account.id))
    .returning();
  return {
    account: updated,
    previousEmails,
    emails,
    primaryChanged:
      previousEmails.find((email) => email.primary)?.email !==
      emails.find((email) => email.primary)?.email,
  };
}

export async function verifyEmail(
  db: Database | Transaction,
  accountId: Uuid,
  sessionId: Uuid,
  token: Uuid,
  code: string,
  now = new Date(),
): Promise<EmailChange | AccountEmailError> {
  // Expected failures are returned, not thrown, so attempts remain committed.
  return await runInTransaction(db, async (tx) => {
    const account = await lockAccount(tx, accountId);
    if (account == null) return new AccountEmailError("NOT_FOUND");
    const [challenge] = await tx
      .select()
      .from(accountEmailChallengeTable)
      .where(eq(accountEmailChallengeTable.token, token))
      .for("update");
    if (
      challenge == null ||
      challenge.accountId !== accountId ||
      challenge.sessionId !== sessionId ||
      challenge.used ||
      challenge.expires <= now ||
      challenge.attempts >= 5
    )
      return new AccountEmailError("INVALID_CODE");
    const actual = hashCode(token, code.trim().toUpperCase());
    if (
      !timingSafeEqual(
        Buffer.from(challenge.codeHash, "hex"),
        Buffer.from(actual, "hex"),
      )
    ) {
      await tx
        .update(accountEmailChallengeTable)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(accountEmailChallengeTable.token, token));
      return new AccountEmailError("INVALID_CODE");
    }
    const previousEmails = await tx
      .select()
      .from(accountEmailTable)
      .where(eq(accountEmailTable.accountId, accountId));
    if (
      previousEmails.filter((email) => email.verified != null).length >=
      EMAIL_LIMIT
    )
      return new AccountEmailError("LIMIT_REACHED");
    const existing = await findAccountEmail(tx, challenge.email);
    if (existing != null && existing.accountId !== accountId)
      return new AccountEmailError("UNAVAILABLE");
    if (existing?.verified != null)
      return new AccountEmailError("ALREADY_REGISTERED");
    const primary = !previousEmails.some((email) => email.primary);
    if (existing != null) {
      await tx
        .update(accountEmailTable)
        .set({ verified: now, primary })
        .where(eq(accountEmailTable.email, existing.email));
    } else {
      const inserted = await tx
        .insert(accountEmailTable)
        .values({ email: challenge.email, accountId, verified: now, primary })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) return new AccountEmailError("UNAVAILABLE");
    }
    await tx
      .update(accountEmailChallengeTable)
      .set({ used: true })
      .where(eq(accountEmailChallengeTable.token, token));
    return await changed(tx, account, previousEmails, now);
  });
}

export async function setPrimaryEmail(
  db: Database | Transaction,
  accountId: Uuid,
  email: string,
  now = new Date(),
): Promise<EmailChange | AccountEmailError> {
  return await runInTransaction(db, async (tx) => {
    const account = await lockAccount(tx, accountId);
    if (account == null) return new AccountEmailError("NOT_FOUND");
    const previousEmails = await tx
      .select()
      .from(accountEmailTable)
      .where(eq(accountEmailTable.accountId, accountId));
    const target = previousEmails.find(
      (item) => item.email.toLowerCase() === email.toLowerCase(),
    );
    if (target == null) return new AccountEmailError("NOT_FOUND");
    if (target.verified == null) return new AccountEmailError("UNVERIFIED");
    // Clear first: the partial unique index is not deferrable.
    await tx
      .update(accountEmailTable)
      .set({ primary: false })
      .where(eq(accountEmailTable.accountId, accountId));
    await tx
      .update(accountEmailTable)
      .set({ primary: true })
      .where(eq(accountEmailTable.email, target.email));
    return await changed(tx, account, previousEmails, now);
  });
}

export async function removeEmail(
  db: Database | Transaction,
  accountId: Uuid,
  email: string,
  now = new Date(),
): Promise<EmailChange | AccountEmailError> {
  return await runInTransaction(db, async (tx) => {
    const account = await lockAccount(tx, accountId);
    if (account == null) return new AccountEmailError("NOT_FOUND");
    const previousEmails = await tx
      .select()
      .from(accountEmailTable)
      .where(eq(accountEmailTable.accountId, accountId));
    const target = previousEmails.find(
      (item) => item.email.toLowerCase() === email.toLowerCase(),
    );
    if (target == null) return new AccountEmailError("NOT_FOUND");
    if (
      target.verified != null &&
      previousEmails.filter((item) => item.verified != null).length <= 1
    )
      return new AccountEmailError("LAST_EMAIL");
    if (target.primary) return new AccountEmailError("PRIMARY_EMAIL");
    await tx
      .delete(accountEmailTable)
      .where(eq(accountEmailTable.email, target.email));
    await tx
      .update(accountTable)
      // Advance even when two removals share the same millisecond.
      .set({
        emailCredentialsChanged: new Date(
          Math.max(
            now.getTime(),
            (account.emailCredentialsChanged?.getTime() ?? -1) + 1,
          ),
        ),
      })
      .where(eq(accountTable.id, accountId));
    return await changed(tx, account, previousEmails, now);
  });
}

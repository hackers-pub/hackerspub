import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Keyv from "keyv";
import { type Database, type Transaction, runInTransaction } from "./db.ts";
import { resolvePasskeyOrigins, type PasskeyPlatform } from "./passkey.ts";
import {
  accountRecoveryCodeTable,
  accountTable,
  passkeyTable,
  type Account,
} from "./schema.ts";
import { sessionMatchesAccount, type Session } from "./session.ts";
import type { Uuid } from "./uuid.ts";

export const SECURITY_ACTIONS = [
  "ENABLE",
  "DISABLE",
  "REGENERATE",
  "REGISTER",
  "REVOKE",
] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];
export const SECURITY_ERRORS = [
  "PASSKEY_REQUIRED",
  "INVALID_ASSERTION",
  "NOT_FOUND",
  "ALREADY_ENABLED",
  "NOT_ENABLED",
] as const;
export type SecurityErrorCode = (typeof SECURITY_ERRORS)[number];
export class AccountSecurityError extends Error {
  readonly code: SecurityErrorCode;
  constructor(code: SecurityErrorCode) {
    super(code);
    this.code = code;
  }
}
export interface SecurityProof {
  challengeId: Uuid;
  authenticationResponse: AuthenticationResponseJSON;
  platform?: PasskeyPlatform;
}
interface SecurityChallenge {
  accountId: Uuid;
  sessionId: Uuid;
  action: SecurityAction;
  generation: number;
  options: PublicKeyCredentialRequestOptionsJSON;
  expires: number;
}
const challengeKey = (id: Uuid) => `account-security/assertion/${id}`;
const grantKey = (id: Uuid) => `account-security/registration/${id}`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function lockSecurityAccount(
  tx: Transaction,
  session: Session,
): Promise<Account> {
  const [account] = await tx
    .select()
    .from(accountTable)
    .where(eq(accountTable.id, session.accountId))
    .for("update");
  if (account == null || !sessionMatchesAccount(session, account))
    throw new AccountSecurityError("NOT_FOUND");
  return account;
}

export async function getSecurityAuthenticationOptions(
  db: Database | Transaction,
  kv: Keyv,
  origin: string,
  session: Session,
  action: SecurityAction,
): Promise<{
  challengeId: Uuid;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  return await runInTransaction(db, async (tx) => {
    const account = await lockSecurityAccount(tx, session);
    const passkeys = await tx
      .select()
      .from(passkeyTable)
      .where(eq(passkeyTable.accountId, account.id));
    if (passkeys.length === 0)
      throw new AccountSecurityError("PASSKEY_REQUIRED");
    const options = await generateAuthenticationOptions({
      rpID: new URL(origin).hostname,
      userVerification: "required",
      allowCredentials: passkeys.map((key) => ({
        id: key.id,
        transports: key.transports ?? undefined,
      })),
    });
    const challengeId = crypto.randomUUID();
    await kv.set(
      challengeKey(challengeId),
      {
        accountId: account.id,
        sessionId: session.id,
        action,
        generation: account.emailSessionGeneration,
        options,
        expires: Date.now() + 300000,
      } satisfies SecurityChallenge,
      300000,
    );
    return { challengeId, options };
  });
}

/** Caller holds the account lock across proof consumption and the protected write. */
export async function verifySecurityAssertion(
  tx: Transaction,
  kv: Keyv,
  origin: string,
  account: Account,
  session: Session,
  action: SecurityAction,
  proof: SecurityProof | undefined,
): Promise<void> {
  if (proof == null) throw new AccountSecurityError("INVALID_ASSERTION");
  const challenge = await kv.get<SecurityChallenge>(
    challengeKey(proof.challengeId),
  );
  if (
    challenge == null ||
    challenge.accountId !== account.id ||
    challenge.sessionId !== session.id ||
    challenge.action !== action ||
    challenge.generation !== account.emailSessionGeneration ||
    challenge.expires <= Date.now()
  )
    throw new AccountSecurityError("INVALID_ASSERTION");
  // Syncable authenticators can always report counter zero. Challenge consumption,
  // serialized by the account lock, is therefore the actual replay boundary.
  if (!(await kv.delete(challengeKey(proof.challengeId))))
    throw new AccountSecurityError("INVALID_ASSERTION");
  const response = proof.authenticationResponse;
  if (response == null || typeof response.id !== "string")
    throw new AccountSecurityError("INVALID_ASSERTION");
  const [passkey] = await tx
    .select()
    .from(passkeyTable)
    .where(
      and(
        eq(passkeyTable.id, response.id),
        eq(passkeyTable.accountId, account.id),
      ),
    );
  if (passkey == null) throw new AccountSecurityError("INVALID_ASSERTION");
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.options.challenge,
      expectedOrigin: resolvePasskeyOrigins(origin, proof.platform),
      expectedRPID: new URL(origin).hostname,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports ?? undefined,
      },
    });
  } catch {
    throw new AccountSecurityError("INVALID_ASSERTION");
  }
  if (!result.verified) throw new AccountSecurityError("INVALID_ASSERTION");
  await tx
    .update(passkeyTable)
    .set({
      counter: BigInt(result.authenticationInfo.newCounter),
      lastUsed: new Date(),
    })
    .where(eq(passkeyTable.id, passkey.id));
}

export function normalizeRecoveryCode(code: string): string | undefined {
  if (code.length > 128) return undefined;
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{32}$/.test(normalized) ? normalized : undefined;
}
export function hashRecoveryCode(accountId: Uuid, code: string): string {
  return digest(`hackerspub:recovery:${accountId}:${code}`);
}

export async function changeAccountSecurity(
  db: Database | Transaction,
  kv: Keyv,
  origin: string,
  session: Session,
  action: "ENABLE" | "DISABLE" | "REGENERATE",
  proof: SecurityProof,
): Promise<{ account: Account; recoveryCodes: string[] }> {
  return await runInTransaction(db, async (tx) => {
    const account = await lockSecurityAccount(tx, session);
    if (action === "ENABLE" && !account.emailLoginEnabled)
      throw new AccountSecurityError("ALREADY_ENABLED");
    if (action !== "ENABLE" && account.emailLoginEnabled)
      throw new AccountSecurityError("NOT_ENABLED");
    await verifySecurityAssertion(
      tx,
      kv,
      origin,
      account,
      session,
      action,
      proof,
    );
    // Verification uses an existing key, so enable necessarily satisfies one key
    // plus recovery codes. Revoke takes this same lock and cannot remove the last.
    const recoveryCodes =
      action === "DISABLE"
        ? []
        : Array.from({ length: 10 }, () =>
            randomBytes(16)
              .toString("hex")
              .toUpperCase()
              .match(/.{8}/g)!
              .join("-"),
          );
    await tx
      .delete(accountRecoveryCodeTable)
      .where(eq(accountRecoveryCodeTable.accountId, account.id));
    if (recoveryCodes.length > 0)
      await tx.insert(accountRecoveryCodeTable).values(
        recoveryCodes.map((code) => ({
          accountId: account.id,
          codeHash: hashRecoveryCode(account.id, normalizeRecoveryCode(code)!),
        })),
      );
    const now = new Date();
    const [updated] = await tx
      .update(accountTable)
      .set({
        emailLoginEnabled: action === "DISABLE",
        // Every transition invalidates pending recovery grants and prepared proofs.
        emailSessionGeneration: account.emailSessionGeneration + 1,
        ...(action === "REGENERATE"
          ? {}
          : {
              emailCredentialsChanged: new Date(
                Math.max(
                  now.getTime(),
                  (account.emailCredentialsChanged?.getTime() ?? -1) + 1,
                ),
              ),
            }),
        updated: now,
      })
      .where(eq(accountTable.id, account.id))
      .returning();
    return { account: updated, recoveryCodes };
  });
}

/** Atomic one-time consumption; caller holds the account lock and checks bans. */
export async function consumeRecoveryCode(
  tx: Transaction,
  account: Account,
  code: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (account.emailLoginEnabled || normalized == null) return false;
  const rows = await tx
    .update(accountRecoveryCodeTable)
    .set({ used: new Date() })
    .where(
      and(
        eq(accountRecoveryCodeTable.accountId, account.id),
        eq(
          accountRecoveryCodeTable.codeHash,
          hashRecoveryCode(account.id, normalized),
        ),
        isNull(accountRecoveryCodeTable.used),
      ),
    )
    .returning({ codeHash: accountRecoveryCodeTable.codeHash });
  return rows.length === 1;
}
interface RegistrationGrant {
  accountId: Uuid;
  generation: number;
  tokenHash: string;
  expires: number;
}
export async function createRecoveryRegistrationGrant(
  kv: Keyv,
  account: Account,
  session: Session,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await kv.set(
    grantKey(session.id),
    {
      accountId: account.id,
      generation: account.emailSessionGeneration,
      tokenHash: digest(`hackerspub:registration:${token}`),
      expires: Date.now() + 600000,
    } satisfies RegistrationGrant,
    600000,
  );
  return token;
}
/** Validate without consuming so failed registration can be retried. */
export async function validateRecoveryRegistrationGrant(
  kv: Keyv,
  account: Account,
  session: Session,
  token: string,
): Promise<void> {
  if (session.authenticationMethod !== "recovery" || token.length !== 64)
    throw new AccountSecurityError("INVALID_ASSERTION");
  const grant = await kv.get<RegistrationGrant>(grantKey(session.id));
  if (
    grant == null ||
    grant.accountId !== account.id ||
    grant.generation !== account.emailSessionGeneration ||
    grant.expires <= Date.now() ||
    !timingSafeEqual(
      Buffer.from(grant.tokenHash, "hex"),
      Buffer.from(digest(`hackerspub:registration:${token}`), "hex"),
    )
  )
    throw new AccountSecurityError("INVALID_ASSERTION");
}

/** Caller holds the account lock and has successfully registered the key. */
export async function consumeRecoveryRegistrationGrant(
  kv: Keyv,
  account: Account,
  session: Session,
  token: string,
): Promise<void> {
  await validateRecoveryRegistrationGrant(kv, account, session, token);
  if (!(await kv.delete(grantKey(session.id))))
    throw new AccountSecurityError("INVALID_ASSERTION");
}

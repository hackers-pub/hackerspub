import { getLogger } from "@logtape/logtape";
import type Keyv from "keyv";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "signin"]);

const KV_NAMESPACE = "signin";

export const EXPIRATION: Temporal.Duration = Temporal.Duration.from({
  hours: 12,
});

export const USERNAME_REGEXP = /^[a-z0-9_]{1,15}$/;

export interface SigninToken {
  accountId: Uuid;
  token: Uuid;
  code: string;
  created: Date;
}

export async function createSigninToken(
  kv: Keyv,
  accountId: Uuid,
): Promise<SigninToken> {
  const token = crypto.randomUUID();
  const tokenData: SigninToken = {
    accountId,
    token,
    code: generateTokenCode(),
    created: new Date(),
  };
  await kv.set(
    `${KV_NAMESPACE}/${token}`,
    tokenData,
    EXPIRATION.total("millisecond"),
  );
  logger.debug("Created sign-in token (expires in {expires}): {token}", {
    expires: EXPIRATION,
    token: tokenData,
  });
  return tokenData;
}

export function getSigninToken(
  kv: Keyv,
  token: Uuid,
): Promise<SigninToken | undefined> {
  return kv.get<SigninToken>(`${KV_NAMESPACE}/${token}`);
}

export async function deleteSigninToken(
  kv: Keyv,
  token: Uuid,
): Promise<void> {
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

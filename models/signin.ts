import { getLogger } from "@logtape/logtape";
import { encodeBase64Url } from "@std/encoding/base64url";
import { type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "signin"]);

const KV_NAMESPACE = ["signin"];

export const EXPIRATION = Temporal.Duration.from({ days: 1 });

export interface SigninToken {
  accountId: Uuid;
  token: Uuid;
  code: string;
  created: Date;
}

export async function createSigninToken(
  kv: Deno.Kv,
  accountId: Uuid,
): Promise<SigninToken> {
  const token = crypto.randomUUID();
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  const tokenData: SigninToken = {
    accountId,
    token,
    code: encodeBase64Url(buffer),
    created: new Date(),
  };
  await kv.set(
    [...KV_NAMESPACE, token],
    tokenData,
    { expireIn: EXPIRATION.total("millisecond") },
  );
  logger.debug("Created sign-in token (expires in {expires}): {token}", {
    expires: EXPIRATION,
    token: tokenData,
  });
  return tokenData;
}

export async function getSigninToken(
  kv: Deno.Kv,
  token: Uuid,
): Promise<SigninToken | undefined> {
  const result = await kv.get<SigninToken>([...KV_NAMESPACE, token]);
  return result.value ?? undefined;
}

export async function deleteSigninToken(
  kv: Deno.Kv,
  token: Uuid,
): Promise<void> {
  await kv.delete([...KV_NAMESPACE, token]);
}

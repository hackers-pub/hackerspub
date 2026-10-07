import type Keyv from "keyv";
import type { Account } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const KV_NAMESPACE = "session";

export const EXPIRATION: Temporal.Duration = Temporal.Duration.from({
  hours: 24 * 365,
});

export interface Session {
  id: Uuid;
  accountId: Uuid;
  userAgent?: string | null;
  ipAddress?: string | null;
  created: Date;
  authenticationMethod?: "email" | "passkey" | "recovery";
  emailSessionGeneration?: number;
}

/** Unknown legacy authentication methods fail closed once strict mode is used. */
export function sessionMatchesAccount(
  session: Session,
  account: Pick<
    Account,
    "id" | "kind" | "emailLoginEnabled" | "emailSessionGeneration"
  >,
): boolean {
  if (session.accountId !== account.id || account.kind !== "personal")
    return false;
  if (
    session.authenticationMethod === "passkey" ||
    session.authenticationMethod === "recovery"
  )
    return true;
  return (
    account.emailLoginEnabled &&
    (session.emailSessionGeneration ?? 0) === account.emailSessionGeneration
  );
}

export async function createSession(
  kv: Keyv,
  session: Omit<Session, "id" | "created"> &
    Pick<Partial<Session>, "id" | "created">,
): Promise<Session> {
  const id = session.id ?? crypto.randomUUID();
  const data = { ...session, id, created: session.created ?? new Date() };
  await kv.set(`${KV_NAMESPACE}/${id}`, data, EXPIRATION.total("millisecond"));
  return data;
}

export function getSession(
  kv: Keyv,
  sessionId: Uuid,
): Promise<Session | undefined> {
  return kv.get<Session>(`${KV_NAMESPACE}/${sessionId}`);
}

export function deleteSession(kv: Keyv, sessionId: Uuid): Promise<boolean> {
  return kv.delete(`${KV_NAMESPACE}/${sessionId}`);
}

/** Recent authentication authorizes sensitive email changes for ten minutes. */
export function getSessionFreshUntil(
  session: Session,
  now = new Date(),
): Date | undefined {
  // Persistent Keyv adapters deserialize Date values as ISO strings.
  const created = new Date(session.created).getTime();
  const deadline = created + 10 * 60 * 1000;
  if (
    !Number.isFinite(created) ||
    // A fresh session can originate on another API replica.
    created > now.getTime() + 60 * 1000 ||
    deadline <= now.getTime()
  )
    return undefined;
  return new Date(deadline);
}

import type Keyv from "keyv";
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
}

export async function createSession(
  kv: Keyv,
  session:
    & Omit<Session, "id" | "created">
    & Pick<Partial<Session>, "id" | "created">,
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

export function deleteSession(
  kv: Keyv,
  sessionId: Uuid,
): Promise<boolean> {
  return kv.delete(`${KV_NAMESPACE}/${sessionId}`);
}

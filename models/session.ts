import { Uuid } from "./uuid.ts";

const KV_NAMESPACE = ["session"];

export const EXPIRATION = Temporal.Duration.from({ hours: 24 * 365 });

export interface Session {
  id: Uuid;
  accountId: Uuid;
  userAgent?: string | null;
  ipAddress?: string | null;
  created: Date;
}

export async function createSession(
  kv: Deno.Kv,
  session:
    & Omit<Session, "id" | "created">
    & Pick<Partial<Session>, "id" | "created">,
): Promise<Session> {
  const id = session.id ?? crypto.randomUUID();
  const data = { ...session, id, created: session.created ?? new Date() };
  await kv.set([...KV_NAMESPACE, id], data, {
    expireIn: EXPIRATION.total("millisecond"),
  });
  return data;
}

export async function getSession(
  kv: Deno.Kv,
  sessionId: Uuid,
): Promise<Session | undefined> {
  const result = await kv.get<Session>([...KV_NAMESPACE, sessionId]);
  return result.value ?? undefined;
}

export async function deleteSession(
  kv: Deno.Kv,
  sessionId: Uuid,
): Promise<void> {
  await kv.delete([...KV_NAMESPACE, sessionId]);
}

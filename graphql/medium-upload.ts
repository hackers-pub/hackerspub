import type { Disk } from "flydrive";
import type Keyv from "keyv";
import {
  MAX_STREAMING_MEDIUM_IMAGE_SIZE,
  SUPPORTED_MEDIUM_IMAGE_TYPES,
} from "@hackerspub/models/medium";
import type { Uuid } from "@hackerspub/models/uuid";
import { validateUuid } from "@hackerspub/models/uuid";

const KV_NAMESPACE = "medium-upload";
export const MEDIUM_UPLOAD_TTL_MS = 30 * 60 * 1000;

export interface MediumUploadSession {
  id: Uuid;
  accountId: Uuid;
  key: string;
  token: string;
  contentType: string;
  contentLength: number;
  created: string;
}

export function getMediumUploadSessionKey(id: Uuid): string {
  return `${KV_NAMESPACE}/${id}`;
}

export async function createMediumUploadSession(
  kv: Keyv,
  accountId: Uuid,
  contentType: string,
  contentLength: number,
): Promise<MediumUploadSession> {
  const id = crypto.randomUUID() as Uuid;
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = [...tokenBytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const session: MediumUploadSession = {
    id,
    accountId,
    key: `medium-uploads/${accountId}/${id}`,
    token,
    contentType,
    contentLength,
    created: new Date().toISOString(),
  };
  await kv.set(getMediumUploadSessionKey(id), session, MEDIUM_UPLOAD_TTL_MS);
  return session;
}

export async function getMediumUploadSession(
  kv: Keyv,
  id: Uuid,
): Promise<MediumUploadSession | undefined> {
  return await kv.get<MediumUploadSession>(getMediumUploadSessionKey(id));
}

export async function deleteMediumUploadSession(
  kv: Keyv,
  id: Uuid,
): Promise<void> {
  await kv.delete(getMediumUploadSessionKey(id));
}

async function readRequestBody(
  request: Request,
  maxSize: number,
): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (reader == null) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxSize) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handleMediumUploadProxy(
  request: Request,
  kv: Keyv,
  disk: Disk,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/medium-uploads\/([^/]+)$/);
  if (match == null) return undefined;
  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", {
      status: 405,
    });
  }
  const uploadId = match[1];
  if (!validateUuid(uploadId)) {
    return new Response("Not Found", {
      status: 404,
    });
  }
  const session = await getMediumUploadSession(kv, uploadId);
  if (session == null || url.searchParams.get("token") !== session.token) {
    return new Response("Forbidden", { status: 403 });
  }
  const contentType = request.headers.get("Content-Type")?.split(";")[0]
    .trim();
  if (
    contentType == null ||
    contentType !== session.contentType ||
    !SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
      contentType as typeof SUPPORTED_MEDIUM_IMAGE_TYPES[number],
    )
  ) {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength == null || !/^\d+$/.test(contentLength)) {
    return new Response("Length Required", { status: 411 });
  }
  const length = Number(contentLength);
  if (
    !Number.isSafeInteger(length) ||
    length !== session.contentLength ||
    length > MAX_STREAMING_MEDIUM_IMAGE_SIZE
  ) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const bytes = await readRequestBody(
    request,
    Math.min(session.contentLength, MAX_STREAMING_MEDIUM_IMAGE_SIZE),
  );
  if (
    bytes == null ||
    bytes.byteLength !== session.contentLength ||
    bytes.byteLength > MAX_STREAMING_MEDIUM_IMAGE_SIZE
  ) {
    return new Response("Payload Too Large", { status: 413 });
  }
  await disk.put(session.key, bytes, { contentType: session.contentType });
  return new Response(null, { status: 204 });
}

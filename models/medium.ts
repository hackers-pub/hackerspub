import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getUserAgent } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import ffmpeg from "fluent-ffmpeg";
import type { Disk } from "flydrive";
import sharp from "sharp";
import { isSSRFSafeURL } from "ssrfcheck";
import type { ContextData } from "./context.ts";
import type { Database } from "./db.ts";
import metadata from "./deno.json" with { type: "json" };
import {
  isPostMediumType,
  type Medium,
  mediumTable,
  type MediumType,
  type NewMedium,
  type NewPostMedium,
  type PostMedium,
  postMediumTable,
  type PostMediumType,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const mediaTypes: Record<string, PostMediumType> = {
  "gif": "image/gif",
  "jpeg": "image/jpeg",
  "jpg": "image/jpeg",
  "png": "image/png",
  "svg": "image/svg+xml",
  "webp": "image/webp",
  "mp4": "video/mp4",
  "m4v": "video/mp4",
  "webm": "video/webm",
  "mov": "video/quicktime",
  "qt": "video/quicktime",
};

export const SUPPORTED_MEDIUM_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export const MAX_MEDIUM_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_STREAMING_MEDIUM_IMAGE_SIZE = 50 * 1024 * 1024;

const localMediumType: MediumType = "image/webp";

type MediumPreprocess = (
  bytes: Uint8Array,
) => Promise<{ bytes: Uint8Array; contentType?: string | null }>;

export class UnsafeMediumUrlError extends Error {
  constructor(url: string) {
    super(`Unsafe medium URL: ${url}`);
    this.name = "UnsafeMediumUrlError";
  }
}

function isSupportedMediumImageType(value: string | null): boolean {
  return value != null &&
    SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
      value.split(";")[0].trim() as typeof SUPPORTED_MEDIUM_IMAGE_TYPES[number],
    );
}

function assertSafeRemoteMediumUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeMediumUrlError(url.href);
  }
  if (!isSSRFSafeURL(url.href, { autoPrependProtocol: false })) {
    throw new UnsafeMediumUrlError(url.href);
  }
}

async function fetchMediumUrl(
  url: URL,
  userAgentUrl: URL | undefined,
): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects < 6; redirects++) {
    assertSafeRemoteMediumUrl(current);
    const response = await fetch(current, {
      headers: {
        "User-Agent": getUserAgent({
          software: `HackersPub/${metadata.version}`,
          url: userAgentUrl ?? new URL("https://hackers.pub/"),
        }),
      },
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("Location");
    if (location == null) return response;
    current = new URL(location, current);
  }
  return new Response(null, { status: 508 });
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(data.byteLength);
  digestInput.set(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readResponseBytes(
  response: Response,
  maxSize: number,
): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
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

export async function createMediumFromBytes(
  db: Database,
  disk: Disk,
  bytes: Uint8Array | ArrayBuffer,
  options: {
    maxSize?: number;
    contentType?: string | null;
    preprocess?: MediumPreprocess;
  } = {},
): Promise<Medium | undefined> {
  let input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let contentType = options.contentType;
  if (input.byteLength > (options.maxSize ?? MAX_MEDIUM_IMAGE_SIZE)) {
    return undefined;
  }
  if (
    contentType != null &&
    !isSupportedMediumImageType(contentType)
  ) {
    return undefined;
  }
  let data: Uint8Array;
  let width: number | undefined;
  let height: number | undefined;
  try {
    if (options.preprocess != null) {
      const processed = await options.preprocess(input);
      input = processed.bytes;
      contentType = processed.contentType ?? contentType;
      if (input.byteLength > (options.maxSize ?? MAX_MEDIUM_IMAGE_SIZE)) {
        return undefined;
      }
      if (contentType != null && !isSupportedMediumImageType(contentType)) {
        return undefined;
      }
    }
    const result = await sharp(input, { animated: true })
      .rotate()
      .webp()
      .toBuffer({ resolveWithObject: true });
    data = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    return undefined;
  }
  if (width == null || height == null) return undefined;
  const contentHash = await sha256Hex(new Uint8Array(data));
  const existing = await db.query.mediumTable.findFirst({
    where: { contentHash },
  });
  if (existing != null) return existing;
  const key = `media/${contentHash}.webp`;
  await disk.put(key, new Uint8Array(data), { contentType: localMediumType });
  const rows = await db.insert(mediumTable).values(
    {
      id: generateUuidV7(),
      key,
      type: localMediumType,
      contentHash,
      width,
      height,
    } satisfies NewMedium,
  ).onConflictDoUpdate({
    target: mediumTable.key,
    set: {
      contentHash,
      width,
      height,
      type: localMediumType,
    },
  }).returning();
  return rows[0];
}

export async function createMediumFromBlob(
  db: Database,
  disk: Disk,
  blob: Blob,
  options: { maxSize?: number; preprocess?: MediumPreprocess } = {},
): Promise<Medium | undefined> {
  if (!isSupportedMediumImageType(blob.type)) return undefined;
  return await createMediumFromBytes(db, disk, await blob.arrayBuffer(), {
    ...options,
    contentType: blob.type,
  });
}

export async function createMediumFromUrl(
  db: Database,
  disk: Disk,
  url: URL,
  options: {
    maxSize?: number;
    userAgentUrl?: URL;
    preprocess?: MediumPreprocess;
  } = {},
): Promise<Medium | undefined> {
  if (
    url.protocol !== "data:" && url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    return undefined;
  }
  const response = url.protocol === "data:"
    ? await fetch(url)
    : await fetchMediumUrl(url, options.userAgentUrl);
  if (!response.ok) return undefined;
  const contentType = response.headers.get("Content-Type");
  if (!isSupportedMediumImageType(contentType)) return undefined;
  const contentLength = response.headers.get("Content-Length");
  const maxSize = options.maxSize ?? MAX_MEDIUM_IMAGE_SIZE;
  if (contentLength != null && Number(contentLength) > maxSize) {
    return undefined;
  }
  const bytes = await readResponseBytes(response, maxSize);
  if (bytes == null) return undefined;
  return await createMediumFromBytes(db, disk, bytes, {
    maxSize,
    contentType,
    preprocess: options.preprocess,
  });
}

export async function createMediumForExistingKey(
  db: Database,
  values: {
    key: string;
    type?: MediumType;
    contentHash?: string | null;
    width?: number | null;
    height?: number | null;
  },
): Promise<Medium> {
  const existing = await db.query.mediumTable.findFirst({
    where: { key: values.key },
  });
  if (existing != null) return existing;
  const rows = await db.insert(mediumTable).values(
    {
      id: generateUuidV7(),
      key: values.key,
      type: values.type ?? localMediumType,
      contentHash: values.contentHash,
      width: values.width,
      height: values.height,
    } satisfies NewMedium,
  ).onConflictDoUpdate({
    target: mediumTable.key,
    set: {
      type: values.type ?? localMediumType,
      contentHash: values.contentHash,
      width: values.width,
      height: values.height,
    },
  }).returning();
  return rows[0];
}

export async function getMediumUrl(
  disk: Disk,
  medium: Pick<Medium, "key">,
): Promise<string> {
  return await disk.getUrl(medium.key);
}

export async function persistPostMedium(
  fedCtx: Context<ContextData>,
  document: vocab.Document,
  postId: Uuid,
  index: number,
): Promise<PostMedium | undefined> {
  const url = document.url instanceof vocab.Link
    ? document.url.href
    : document.url;
  if (url == null) return undefined;
  let mediumType: PostMediumType | undefined;
  if (isPostMediumType(document.mediaType)) {
    mediumType = document.mediaType;
  } else if (
    (document instanceof vocab.Image || document instanceof vocab.Video) &&
    Object.keys(mediaTypes).map((ext) => `.${ext}`).some((ext) =>
      url.pathname.toLowerCase().endsWith(ext)
    )
  ) {
    const m = /\.([^.]+)$/.exec(url.pathname);
    if (!m) return undefined;
    const ext = m[1].toLowerCase();
    if (!(ext in mediaTypes)) return undefined;
    mediumType = mediaTypes[ext];
  } else if (document instanceof vocab.Image) {
    mediumType = undefined;
  } else {
    return undefined;
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": getUserAgent({
        software: `HackersPub/${metadata.version}`,
        url: new URL(fedCtx.canonicalOrigin),
      }),
    },
  });
  if (mediumType == null) {
    const contentType = response.headers.get("content-type");
    if (!isPostMediumType(contentType)) return undefined;
    mediumType = contentType;
  }
  if (response.body == null) return undefined;
  let width: number | null = document.width;
  let height: number | null = document.height;
  let thumbnailKey: string | null = null;
  if (mediumType.startsWith("video/")) {
    const tmpDir = await mkdtemp(join(tmpdir(), "hackerspub-"));
    const source = join(tmpDir, "source");
    try {
      if (response.body == null) return undefined;
      await writeFile(source, response.body);
      if (width == null || height == null) {
        let metadata: ffmpeg.FfprobeData;
        try {
          metadata = await new Promise((resolve, reject) =>
            ffmpeg(source)
              .ffprobe((err, data) => err ? reject(err) : resolve(data))
          );
        } catch {
          return undefined;
        }
        width = metadata.streams[0].width ?? null;
        height = metadata.streams[0].height ?? null;
      }
      await new Promise((resolve) =>
        ffmpeg(source)
          .on("end", resolve)
          .screenshots({
            timestamps: [0],
            filename: "screenshot.png",
            folder: tmpDir,
          })
      );
      const screenshot = join(tmpDir, "screenshot.png");
      await fedCtx.data.disk.put(
        thumbnailKey = `videos/${crypto.randomUUID()}.png`,
        await readFile(screenshot),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  const result = await fedCtx.data.db.insert(postMediumTable).values(
    {
      postId,
      index,
      type: mediumType,
      url: url.href,
      alt: document.name?.toString(),
      width,
      height,
      thumbnailKey,
      sensitive: document.sensitive ?? false,
    } satisfies NewPostMedium,
  ).returning();
  return result.length > 0 ? result[0] : undefined;
}

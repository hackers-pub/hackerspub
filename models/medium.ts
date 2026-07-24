import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { getUserAgent } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import ffmpeg from "fluent-ffmpeg";
import type { StorageService } from "./context.ts";
import sharp from "sharp";
import { isSSRFSafeURL } from "ssrfcheck";
import type { ApplicationContext } from "./context.ts";
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

const logger = getLogger(["hackerspub", "models", "medium"]);

const mediaTypes: Record<string, PostMediumType> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  qt: "video/quicktime",
};

export const SUPPORTED_MEDIUM_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export const MAX_MEDIUM_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_STREAMING_MEDIUM_IMAGE_SIZE = 50 * 1024 * 1024;
const REMOTE_MEDIUM_FETCH_TIMEOUT_MS = 30_000;

const localMediumType: MediumType = "image/webp";

export async function writeResponseToFile(
  response: Response,
  path: string,
): Promise<void> {
  if (response.body == null) {
    throw new TypeError("Response body is unavailable.");
  }
  const body = response.body as unknown as NodeReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(body), createWriteStream(path));
}

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
  return (
    value != null &&
    SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
      value
        .split(";")[0]
        .trim() as (typeof SUPPORTED_MEDIUM_IMAGE_TYPES)[number],
    )
  );
}

function parsePostMediumType(value: string | null): PostMediumType | undefined {
  if (value == null) return undefined;
  const contentType = value.split(";")[0].trim().toLowerCase();
  return isPostMediumType(contentType) ? contentType : undefined;
}

function isGenericBinaryType(value: string | null): boolean {
  if (value == null) return false;
  const contentType = value.split(";")[0].trim().toLowerCase();
  return (
    contentType === "application/octet-stream" ||
    contentType === "binary/octet-stream"
  );
}

function isPotentialPostMediumType(value: string | null): boolean {
  if (value == null) return false;
  const contentType = value.split(";")[0].trim().toLowerCase();
  return contentType.startsWith("image/") || contentType.startsWith("video/");
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REMOTE_MEDIUM_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(current, {
        headers: {
          "User-Agent": getUserAgent({
            software: `HackersPub/${metadata.version}`,
            url: userAgentUrl ?? new URL("https://hackers.pub/"),
          }),
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxSize) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
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
  disk: StorageService,
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
  if (contentType != null && !isSupportedMediumImageType(contentType)) {
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
    const info = result.info as typeof result.info & { pageHeight?: number };
    data = result.data;
    width = info.width;
    // For animated images, Sharp reports the full stacked canvas height in
    // `height`; `pageHeight` is the actual frame height peers expect.
    height = info.pageHeight ?? info.height;
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
  const rows = await db
    .insert(mediumTable)
    .values({
      id: generateUuidV7(),
      key,
      type: localMediumType,
      contentHash,
      width,
      height,
    } satisfies NewMedium)
    .onConflictDoUpdate({
      target: mediumTable.key,
      set: {
        contentHash,
        width,
        height,
        type: localMediumType,
      },
    })
    .returning();
  return rows[0];
}

export async function createMediumFromBlob(
  db: Database,
  disk: StorageService,
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
  disk: StorageService,
  url: URL,
  options: {
    maxSize?: number;
    userAgentUrl?: URL;
    preprocess?: MediumPreprocess;
  } = {},
): Promise<Medium | undefined> {
  if (
    url.protocol !== "data:" &&
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    return undefined;
  }
  const response =
    url.protocol === "data:"
      ? await fetch(url)
      : await fetchMediumUrl(url, options.userAgentUrl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const contentType = response.headers.get("Content-Type");
  if (!isSupportedMediumImageType(contentType)) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  const contentLength = response.headers.get("Content-Length");
  const maxSize = options.maxSize ?? MAX_MEDIUM_IMAGE_SIZE;
  if (contentLength != null && Number(contentLength) > maxSize) {
    await response.body?.cancel().catch(() => {});
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
  const rows = await db
    .insert(mediumTable)
    .values({
      id: generateUuidV7(),
      key: values.key,
      type: values.type ?? localMediumType,
      contentHash: values.contentHash,
      width: values.width,
      height: values.height,
    } satisfies NewMedium)
    .onConflictDoUpdate({
      target: mediumTable.key,
      set: {
        type: values.type ?? localMediumType,
        contentHash: values.contentHash,
        width: values.width,
        height: values.height,
      },
    })
    .returning();
  return rows[0];
}

export async function getMediumUrl(
  disk: StorageService,
  medium: Pick<Medium, "key">,
): Promise<string> {
  return await disk.getUrl(medium.key);
}

export async function persistPostMedium(
  fedCtx: ApplicationContext,
  document: vocab.Document,
  postId: Uuid,
  index: number,
): Promise<PostMedium | undefined> {
  const url =
    document.url instanceof vocab.Link ? document.url.href : document.url;
  if (url == null) return undefined;
  let mediumType: PostMediumType | undefined;
  if (isPostMediumType(document.mediaType)) {
    mediumType = document.mediaType;
  } else if (
    (document instanceof vocab.Image || document instanceof vocab.Video) &&
    Object.keys(mediaTypes)
      .map((ext) => `.${ext}`)
      .some((ext) => url.pathname.toLowerCase().endsWith(ext))
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
  let response: Response;
  try {
    response = await fetchMediumUrl(url, new URL(fedCtx.canonicalOrigin));
  } catch (error) {
    logger.warn("Failed to fetch remote medium {url}: {error}", {
      url: url.href,
      error,
    });
    return undefined;
  }
  if (!response.ok) return undefined;
  const contentType = response.headers.get("content-type");
  const responseMediumType = parsePostMediumType(contentType);
  if (mediumType == null) {
    if (responseMediumType == null) return undefined;
    mediumType = responseMediumType;
  } else if (responseMediumType != null) {
    mediumType = responseMediumType;
  } else if (
    contentType != null &&
    !isGenericBinaryType(contentType) &&
    !isPotentialPostMediumType(contentType)
  ) {
    return undefined;
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
      await writeResponseToFile(response, source);
      if (width == null || height == null) {
        let metadata: ffmpeg.FfprobeData;
        try {
          metadata = await new Promise((resolve, reject) =>
            ffmpeg(source).ffprobe((err, data) =>
              err ? reject(err) : resolve(data),
            ),
          );
        } catch {
          return undefined;
        }
        width = metadata.streams[0].width ?? null;
        height = metadata.streams[0].height ?? null;
      }
      const screenshotCreated = await new Promise<boolean>((resolve) =>
        ffmpeg(source)
          .on("end", () => resolve(true))
          .on("error", () => resolve(false))
          .screenshots({
            timestamps: [0],
            filename: "screenshot.png",
            folder: tmpDir,
          }),
      );
      if (!screenshotCreated) return undefined;
      const screenshot = join(tmpDir, "screenshot.png");
      await fedCtx.storage.put(
        (thumbnailKey = `videos/${crypto.randomUUID()}.png`),
        await readFile(screenshot),
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  const values = {
    postId,
    index,
    type: mediumType,
    url: url.href,
    alt: document.name?.toString(),
    width,
    height,
    thumbnailKey,
    sensitive: document.sensitive ?? false,
  } satisfies NewPostMedium;
  const result = await fedCtx.db
    .insert(postMediumTable)
    .values(values)
    .onConflictDoUpdate({
      target: [postMediumTable.postId, postMediumTable.index],
      set: values,
    })
    .returning();
  return result.length > 0 ? result[0] : undefined;
}

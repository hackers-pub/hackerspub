import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const mediaTypes: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".qt": "video/quicktime",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=UTF-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function parseRange(
  value: string | null,
  size: number,
): ByteRange | null | undefined {
  if (value == null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match == null || (match[1] === "" && match[2] === "")) return undefined;

  const suffixLength = match[1] === "" ? Number(match[2]) : null;
  const start =
    suffixLength == null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end =
    suffixLength == null && match[2] !== "" ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (suffixLength != null &&
      (!Number.isSafeInteger(suffixLength) || suffixLength < 1)) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function matchesIfNoneMatch(value: string, etag: string): boolean {
  if (value.trim() === "*") return true;
  const normalizedEtag = etag.startsWith("W/") ? etag.slice(2) : etag;
  return value.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return (
      (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed) === normalizedEtag
    );
  });
}

export async function handleFileSystemMedia(
  request: Request,
  fileSystemRoot: URL | undefined,
): Promise<Response | null> {
  if (fileSystemRoot == null) return null;
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/media/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice("/media/".length));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const pathSegments = relativePath.split(/[\\/]/);
  if (relativePath.length < 1 || pathSegments.some((part) => part === "..")) {
    return null;
  }
  if (pathSegments.some((part) => part.startsWith("."))) {
    return new Response("Not Found", { status: 404 });
  }

  const rootPath = fileURLToPath(fileSystemRoot);
  const filePath = resolve(rootPath, relativePath);
  const pathWithinRoot = relative(rootPath, filePath);
  if (
    pathWithinRoot === "" ||
    pathWithinRoot === ".." ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  ) {
    return null;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return new Response("Not Found", { status: 404 });
    const contentType =
      mediaTypes[extname(relativePath).toLowerCase()] ??
      "application/octet-stream";
    const etag =
      `W/"${fileStat.size.toString(16)}-` +
      `${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
    const lastModified = fileStat.mtime.toUTCString();
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      ETag: etag,
      "Last-Modified": lastModified,
    };

    if (request.method === "GET") {
      const ifNoneMatch = request.headers.get("if-none-match");
      const ifModifiedSince = request.headers.get("if-modified-since");
      const modifiedSince =
        ifModifiedSince == null ? Number.NaN : Date.parse(ifModifiedSince);
      if (
        (ifNoneMatch != null && matchesIfNoneMatch(ifNoneMatch, etag)) ||
        (ifNoneMatch == null &&
          Number.isFinite(modifiedSince) &&
          fileStat.mtimeMs < modifiedSince + 1000)
      ) {
        return new Response(null, { status: 304, headers: commonHeaders });
      }
    }

    const range =
      request.method === "GET" && fileStat.size > 0
        ? parseRange(request.headers.get("range"), fileStat.size)
        : undefined;
    if (range === null) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          ...commonHeaders,
          "Content-Range": `bytes */${fileStat.size}`,
        },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? fileStat.size - 1;
    const headers = new Headers({
      ...commonHeaders,
      "Content-Length": String(Math.max(0, end - start + 1)),
    });
    if (range !== undefined) {
      headers.set("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
    }
    const body =
      request.method === "HEAD" || fileStat.size === 0
        ? null
        : (Readable.toWeb(
            createReadStream(filePath, { start, end }),
          ) as ReadableStream<Uint8Array>);
    return new Response(body, {
      status: range === undefined ? 200 : 206,
      headers,
    });
  } catch (error) {
    if (
      error != null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return new Response("Not Found", { status: 404 });
    }
    throw error;
  }
}

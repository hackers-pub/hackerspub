import { getUserAgent } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { join } from "@std/path/join";
import ffmpeg from "fluent-ffmpeg";
import type { Disk } from "flydrive";
import type { Database } from "../db.ts";
import metadata from "../deno.json" with { type: "json" };
import { ORIGIN } from "../federation/federation.ts";
import {
  isPostMediumType,
  type NewPostMedium,
  type PostMedium,
  postMediumTable,
  type PostMediumType,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

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
};

export async function persistPostMedium(
  db: Database,
  disk: Disk,
  document: vocab.Document,
  postId: Uuid,
  index: number,
): Promise<PostMedium | undefined> {
  const url = document.url instanceof vocab.Link
    ? document.url.href
    : document.url;
  if (url == null) return undefined;
  let mediumType: PostMediumType;
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
  } else {
    return undefined;
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": getUserAgent({
        software: `HackersPub/${metadata.version}`,
        url: new URL(ORIGIN),
      }),
    },
  });
  if (response.body == null) return undefined;
  let width: number | null = document.width;
  let height: number | null = document.height;
  let thumbnailKey: string | null = null;
  if (mediumType.startsWith("video/")) {
    const tmp = await Deno.makeTempFile({ prefix: "hackerspub" });
    const tmpFile = await Deno.open(tmp, { write: true });
    await response.body.pipeTo(tmpFile.writable);
    const tmpDir = await Deno.makeTempDir({ prefix: "hackerspub" });
    if (width == null || height == null) {
      let metadata: ffmpeg.FfprobeData;
      try {
        metadata = await new Promise((resolve, reject) =>
          ffmpeg(tmp)
            .ffprobe((err, data) => err ? reject(err) : resolve(data))
        );
      } catch {
        return undefined;
      }
      width = metadata.streams[0].width ?? null;
      height = metadata.streams[0].height ?? null;
    }
    await new Promise((resolve) =>
      ffmpeg(tmp)
        .on("end", resolve)
        .screenshots({
          timestamps: [0],
          filename: "screenshot.png",
          folder: tmpDir,
        })
    );
    const screenshot = join(tmpDir, "screenshot.png");
    await disk.put(
      thumbnailKey = `videos/${crypto.randomUUID()}.png`,
      await Deno.readFile(screenshot),
    );
  }
  const result = await db.insert(postMediumTable).values(
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

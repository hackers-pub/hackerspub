import * as vocab from "@fedify/fedify/vocab";
import type { Database } from "../db.ts";
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
};

export async function postMedium(
  db: Database,
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
    document instanceof vocab.Image &&
    url.pathname.match(/\.(gif|jpe?g|png|svg|webp)$/i)
  ) {
    const m = /\.([^.]+)$/.exec(url.pathname);
    if (!m) return undefined;
    const ext = m[1].toLowerCase();
    if (!(ext in mediaTypes)) return undefined;
    mediumType = mediaTypes[ext];
  } else {
    return undefined;
  }
  const result = await db.insert(postMediumTable).values(
    {
      postId,
      index,
      type: mediumType,
      url: url.href,
      alt: document.name?.toString(),
      width: document.width,
      height: document.height,
      sensitive: document.sensitive ?? false,
    } satisfies NewPostMedium,
  ).returning();
  return result.length > 0 ? result[0] : undefined;
}

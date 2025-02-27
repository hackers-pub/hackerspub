import * as vocab from "@fedify/fedify/vocab";
import type { Database } from "../db.ts";
import {
  isPostMediumType,
  type NewPostMedium,
  type PostMedium,
  postMediumTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export async function postMedium(
  db: Database,
  document: vocab.Document,
  postId: Uuid,
  index: number,
): Promise<PostMedium | undefined> {
  if (!isPostMediumType(document.mediaType)) return undefined;
  const url = document.url instanceof vocab.Link
    ? document.url.href
    : document.url;
  if (url == null) return undefined;
  const result = await db.insert(postMediumTable).values(
    {
      postId,
      index,
      type: document.mediaType,
      url: url.href,
      alt: document.name?.toString(),
      width: document.width,
      height: document.height,
      sensitive: document.sensitive ?? false,
    } satisfies NewPostMedium,
  ).returning();
  return result.length > 0 ? result[0] : undefined;
}

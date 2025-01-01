import * as vocab from "@fedify/fedify/vocab";
import type { Database } from "../db.ts";
import { isMediumType, type Medium, mediumTable, NewMedium } from "./schema.ts";
import { Uuid } from "./uuid.ts";

export async function postMedium(
  db: Database,
  document: vocab.Document,
  postId: Uuid,
  index: number,
): Promise<Medium | undefined> {
  if (!isMediumType(document.mediaType)) return undefined;
  const url = document.url instanceof vocab.Link
    ? document.url.href
    : document.url;
  if (url == null) return undefined;
  const result = await db.insert(mediumTable).values(
    {
      postId,
      index,
      type: document.mediaType,
      url: url.href,
      alt: document.name?.toString(),
      width: document.width,
      height: document.height,
      sensitive: document.sensitive ?? false,
    } satisfies NewMedium,
  ).returning();
  return result.length > 0 ? result[0] : undefined;
}

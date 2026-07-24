import { minBy } from "@std/collections/min-by";
import type { StorageService } from "./context.ts";
import type { Database } from "./db.ts";
import type { ArticleContent, ArticleSource } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export async function getArticleDraftMediumUrls(
  db: Database,
  disk: StorageService,
  draftId: Uuid,
): Promise<Record<string, string>> {
  const media = await db.query.articleDraftMediumTable.findMany({
    where: { articleDraftId: draftId },
    with: { medium: true },
  });
  return Object.fromEntries(
    await Promise.all(
      media.map(async (relation) => [
        relation.key,
        await disk.getUrl(relation.medium.key),
      ]),
    ),
  );
}

export async function getArticleSourceMediumUrls(
  db: Database,
  disk: StorageService,
  sourceId: Uuid,
): Promise<Record<string, string>> {
  const media = await db.query.articleSourceMediumTable.findMany({
    where: { articleSourceId: sourceId },
    with: { medium: true },
  });
  return Object.fromEntries(
    await Promise.all(
      media.map(async (relation) => [
        relation.key,
        await disk.getUrl(relation.medium.key),
      ]),
    ),
  );
}

export function getOriginalArticleContent(
  source: ArticleSource & { contents: ArticleContent[] },
): ArticleContent | undefined;
export function getOriginalArticleContent(
  db: Database,
  source: ArticleSource,
): Promise<ArticleContent | undefined>;
export function getOriginalArticleContent(
  dbOrSrc: (ArticleSource & { contents: ArticleContent[] }) | Database,
  source?: ArticleSource,
): ArticleContent | undefined | Promise<ArticleContent | undefined> {
  if ("contents" in dbOrSrc) {
    const contents = dbOrSrc.contents.filter(
      (content) =>
        content.originalLanguage == null &&
        content.translatorId == null &&
        content.translationRequesterId == null,
    );
    return minBy(contents, (content) => +content.published);
  }
  if (source == null) return Promise.resolve(undefined);
  return dbOrSrc.query.articleContentTable.findFirst({
    where: {
      sourceId: source.id,
      originalLanguage: { isNull: true },
      translatorId: { isNull: true },
      translationRequesterId: { isNull: true },
    },
    orderBy: { published: "asc" },
  });
}

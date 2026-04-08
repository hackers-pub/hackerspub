import type { Database } from "./db.ts";
import { flagTable } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export interface CreateFlagResult {
  created: boolean;
  flagId: Uuid;
}

export async function createFlag(
  db: Database,
  id: Uuid,
  iri: string,
  reporterId: Uuid,
  postId: Uuid,
  reason: string,
): Promise<CreateFlagResult> {
  const rows = await db.insert(flagTable)
    .values({ id, iri, reporterId, postId, reason })
    .onConflictDoNothing()
    .returning({ id: flagTable.id });

  if (rows.length > 0) {
    return { created: true, flagId: rows[0].id };
  }

  const existing = await db.query.flagTable.findFirst({
    columns: { id: true },
    where: { reporterId, postId },
  });

  return { created: false, flagId: existing!.id };
}

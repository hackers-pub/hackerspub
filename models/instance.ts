import { formatSemVer, getNodeInfo } from "@fedify/fedify";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import { type Instance, instanceTable, type NewInstance } from "./schema.ts";

export interface PersistInstanceOptions {
  skipUpdate?: boolean;
}

export async function persistInstance(
  db: Database,
  host: string,
  options: PersistInstanceOptions = {},
): Promise<Instance> {
  if (options.skipUpdate) {
    const instance = await db.query.instanceTable.findFirst({
      where: eq(instanceTable.host, host),
    });
    if (instance != null) return instance;
  }
  const nodeInfo = await getNodeInfo(
    `https://${host}/`,
    { parse: "best-effort" },
  );
  const values: NewInstance = {
    host,
    software: nodeInfo?.software?.name ?? null,
    softwareVersion: nodeInfo?.software == null ||
        formatSemVer(nodeInfo.software.version) === "0.0.0"
      ? null
      : formatSemVer(nodeInfo.software.version),
  };
  const rows = await db.insert(instanceTable)
    .values(values)
    .onConflictDoUpdate({
      target: instanceTable.host,
      set: {
        ...values,
        updated: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: eq(instanceTable.host, host),
    })
    .returning();
  return rows[0];
}

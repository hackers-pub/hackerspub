import { createDatabaseResources } from "@hackerspub/runtime/resources";

const url = Deno.env.get("DATABASE_URL");
if (url == null || url.trim() === "") {
  throw new Error("DATABASE_URL is required by the PostgreSQL test fixture");
}

export const { db, postgres } = createDatabaseResources({ url });

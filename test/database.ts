import { createDatabaseResources } from "@hackerspub/runtime/resources";
import process from "node:process";
import { after } from "node:test";

const url = process.env.DATABASE_URL;
if (url == null || url.trim() === "") {
  throw new Error("DATABASE_URL is required by the PostgreSQL test fixture");
}

export const { db, postgres } = createDatabaseResources({ url });

if (!("Deno" in globalThis)) {
  after(async () => {
    await postgres.end();
  });
}

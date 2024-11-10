import process from "node:process";
import { defineConfig } from "drizzle-kit";

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export default defineConfig({
  out: "./drizzle",
  schema: "./models/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: DATABASE_URL,
  },
});

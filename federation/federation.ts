import { createFederation } from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { postgres } from "../db.ts";
import { tracerProvider } from "../sentry.ts";

export const federation = createFederation<void>({
  kv: new PostgresKvStore(postgres),
  queue: new PostgresMessageQueue(postgres),
  userAgent: {
    software: "HackersPub",
  },
  tracerProvider,
});

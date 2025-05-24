import type { LanguageModelV1 } from "ai";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "./db.ts";

export interface Models {
  translator: LanguageModelV1;
  summarizer: LanguageModelV1;
}

export interface ContextData<D extends Database = Database> {
  db: D;
  kv: Keyv;
  disk: Disk;
  models: Models;
}

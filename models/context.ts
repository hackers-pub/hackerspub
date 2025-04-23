import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "./db.ts";

export interface ContextData {
  db: Database;
  kv: Keyv;
  disk: Disk;
}

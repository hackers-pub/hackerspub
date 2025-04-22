import {
  createFederationBuilder,
  type FederationBuilder,
} from "@fedify/fedify";
import type { Database } from "@hackerspub/models/db";
import type { Disk } from "flydrive";
import type Keyv from "keyv";

export interface ContextData {
  db: Database;
  kv: Keyv;
  disk: Disk;
}

export const builder: FederationBuilder<ContextData> = createFederationBuilder<
  ContextData
>();

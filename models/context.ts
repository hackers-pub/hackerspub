import type { Context } from "@fedify/fedify";
import type { LanguageModel } from "ai";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "./db.ts";
import type { ApplicationServices } from "./services.ts";

export type AfterCommitTask = () => Promise<void> | void;

export interface Models {
  translator: LanguageModel;
  summarizer: LanguageModel;
  /**
   * Matches reports against the code of conduct (a reference tool for
   * moderators, never an automated decision system).
   */
  moderationAnalyzer: LanguageModel;
}

export interface ContextData<D extends Database = Database> {
  db: D;
  rootDb?: Database;
  afterCommit?: AfterCommitTask[];
  kv: Keyv;
  disk: Disk;
  models: Models;
  services: ApplicationServices<Context<ContextData>>;
}

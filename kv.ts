import KeyvRedis from "@keyv/redis";
import { KeyvFile } from "keyv-file";
import Keyv from "keyv";

const KV_URL = Deno.env.get("KV_URL");
if (KV_URL == null) {
  throw new Error("Missing KV_URL environment variable.");
} else if (!URL.canParse(KV_URL)) {
  throw new Error("Invalid KV_URL environment variable; must be a valid URL.");
}

const kvUrl = new URL(KV_URL);
if (kvUrl.protocol !== "file:" && kvUrl.protocol !== "redis:") {
  throw new Error(
    "Invalid KV_URL environment variable; must start with file: or redis:",
  );
}

export const kvAdaptor = kvUrl.protocol === "file:"
  ? new KeyvFile({ filename: kvUrl.pathname })
  : new KeyvRedis(KV_URL);
export const kv = new Keyv(kvAdaptor);

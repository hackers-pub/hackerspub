import * as models from "./ai.ts";
import { db } from "./db.ts";
import { drive } from "./drive.ts";
import { transport as email } from "./email.ts";
import { federation } from "./federation.ts";
import { kv } from "./kv.ts";
import { createYogaServer } from "./mod.ts";

const yogaServer = createYogaServer();

Deno.serve({ port: 8080 }, async (req, info) => {
  const disk = drive.use();
  return yogaServer.fetch(req, {
    db,
    kv,
    disk,
    email,
    fedCtx: federation.createContext(req, { db, kv, disk, models }),
    request: req,
    connectionInfo: info,
  });
});

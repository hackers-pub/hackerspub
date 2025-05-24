import { getCookies } from "@std/http/cookie";
import { getSession } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import { createYogaServer } from "./mod.ts";
import { db } from "./db.ts";
import { kv } from "./kv.ts";
import { drive } from "./drive.ts";
import { federation } from "./federation.ts";
import * as models from "./ai.ts";

const yogaServer = createYogaServer();

Deno.serve({ port: 8080 }, (req) => {
  const cookies = getCookies(req.headers);
  const session = validateUuid(cookies.session)
    ? getSession(kv, cookies.session)
    : undefined;

  const disk = drive.use();
  return yogaServer.fetch(req, {
    db,
    kv,
    disk,
    session,
    fedCtx: federation.createContext(req, { db, kv, disk, models }),
    moderator: false,
  });
});

import { getSession } from "@hackerspub/models/session";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { getCookies } from "@std/http/cookie";
import * as models from "./ai.ts";
import { db } from "./db.ts";
import { drive } from "./drive.ts";
import { transport as email } from "./email.ts";
import { federation } from "./federation.ts";
import { kv } from "./kv.ts";
import { createYogaServer } from "./mod.ts";

const yogaServer = createYogaServer();

Deno.serve({ port: 8080 }, (req, info) => {
  let sessionId: Uuid | undefined = undefined;
  const authorization = req.headers.get("Authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    const uuid = authorization.slice(7).trim();
    if (validateUuid(uuid)) sessionId = uuid;
  }
  if (sessionId == null) {
    const cookies = getCookies(req.headers);
    if (validateUuid(cookies.session)) sessionId = cookies.session;
  }
  const session = sessionId == null ? undefined : getSession(kv, sessionId);

  const disk = drive.use();
  return yogaServer.fetch(req, {
    db,
    kv,
    disk,
    email,
    session,
    fedCtx: federation.createContext(req, { db, kv, disk, models }),
    request: req,
    connectionInfo: info,
  });
});

import { getSession } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import { getCookies } from "@std/http/cookie";
import * as models from "./ai.ts";
import { db } from "./db.ts";
import { drive } from "./drive.ts";
import { transport as email } from "./email.ts";
import { federation } from "./federation.ts";
import { kv } from "./kv.ts";
import { createYogaServer } from "./mod.ts";

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
    email,
    session,
    fedCtx: federation.createContext(req, { db, kv, disk, models }),
    moderator: false,
  });
});

import type { Account, Actor } from "@hackerspub/models/schema";
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

Deno.serve({ port: 8080 }, async (req, info) => {
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
  let session = sessionId == null ? undefined : await getSession(kv, sessionId);

  let account: Account & { actor: Actor } | undefined = undefined;
  if (session != null) {
    account = await db.query.accountTable.findFirst({
      where: { id: session.accountId },
      with: {
        actor: true,
      },
    });
    if (account == null) session = undefined;
  }

  const disk = drive.use();
  return yogaServer.fetch(req, {
    db,
    kv,
    disk,
    email,
    session,
    account,
    fedCtx: federation.createContext(req, { db, kv, disk, models }),
    request: req,
    connectionInfo: info,
  });
});

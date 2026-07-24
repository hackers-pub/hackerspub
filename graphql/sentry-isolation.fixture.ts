import { setUser } from "@sentry/node";
import * as Sentry from "@sentry/node-sdk";
import process from "node:process";
import { createNodeHttpServer } from "./node-http.ts";

const barrier = Promise.withResolvers<void>();
let concurrentRequests = 0;
let barrierOpen = true;

const api = createNodeHttpServer(async (request) => {
  const user = new URL(request.url).searchParams.get("user");
  setUser(user == null ? null : { id: user });
  if (barrierOpen && user != null) {
    concurrentRequests++;
    if (concurrentRequests === 2) {
      barrierOpen = false;
      barrier.resolve();
    }
    await barrier.promise;
  }
  return new Response(
    String(Sentry.getIsolationScope().getUser()?.id ?? "anonymous"),
  );
});

const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
try {
  const baseUrl = `http://127.0.0.1:${address.port}/graphql`;
  const concurrent = await Promise.all(
    ["alice", "bob"].map(async (user) => {
      const response = await fetch(`${baseUrl}?user=${user}`);
      return await response.text();
    }),
  );
  const guest = await (await fetch(baseUrl)).text();
  process.stdout.write(`${JSON.stringify({ concurrent, guest })}\n`);
} finally {
  await api.close();
  await Sentry.close(100);
}

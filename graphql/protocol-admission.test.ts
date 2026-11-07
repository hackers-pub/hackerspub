import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  getRequestWorkSignal,
  reportRequestDependencyInterruption,
  reportRequestWorkFailure,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import { loadProtocolHttpConfig } from "@hackerspub/runtime/config";
import { createNodeHttpServer } from "./node-http.ts";
import { ProtocolAdmission } from "./protocol-admission.ts";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

function admission(options = {}) {
  return new ProtocolAdmission({
    ...loadProtocolHttpConfig({}),
    deadlineMs: 1000,
    limit: 1,
    ...options,
  });
}
const request = () => new Request("https://local.example/ap/notes/1");

test("protocol shedding has no queue and does not release unfinished work on deadline", async () => {
  const gate = admission({ deadlineMs: 20 });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const first = gate.run(request(), async () => {
    signal = getRequestWorkSignal();
    entered.resolve();
    await release.promise;
    return new Response("late");
  });
  await entered.promise;
  const shed = await gate.run(request(), async () => {
    throw Error("must not start");
  });
  assert.equal(shed.status, 503);
  assert.equal(shed.headers.get("retry-after"), "1");
  assert.equal(shed.headers.get("cache-control"), "no-store");
  assert.equal((await first).status, 504);
  assert.equal(signal?.aborted, true);
  assert.equal(gate.stats.active, 1);
  assert.equal(gate.stats.queued, 0);
  assert.equal(
    (await gate.run(request(), async () => new Response())).status,
    503,
  );
  release.resolve();
  await gate.idle();
  assert.equal(gate.stats.active, 0);
});

test("disconnect and shutdown keep their permits until actual completion", async () => {
  const gate = admission();
  const client = new AbortController();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const run = gate.run(
    new Request(request(), { signal: client.signal }),
    async () => {
      entered.resolve();
      await release.promise;
      return new Response("late");
    },
  );
  await entered.promise;
  client.abort();
  assert.equal((await run).status, 499);
  gate.stop();
  assert.equal(gate.stats.stopping, true);
  assert.equal(
    (await gate.run(request(), async () => new Response())).status,
    503,
  );
  assert.equal(gate.stats.active, 1);
  gate.abort();
  release.resolve();
  await gate.idle();
});

test("hard overload survives a swallowed successful response; optional lookup fallback survives", async () => {
  const gate = admission();
  const hard = await gate.run(request(), async () => {
    reportRequestWorkFailure({ kind: "overload", error: new Error("budget") });
    return new Response("caught");
  });
  assert.equal(hard.status, 503);
  await gate.idle();
  assert.equal(
    (
      await gate.run(request(), async () => {
        reportRequestDependencyInterruption(new Error("optional lookup"));
        return new Response("fallback");
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await gate.run(request(), async () => {
        reportRequestDependencyInterruption(new Error("signature key"));
        return new Response("Unauthorized", { status: 401 });
      })
    ).status,
    504,
  );
  assert.equal(
    (
      await gate.run(
        request(),
        async () => new Response("Unauthorized", { status: 401 }),
      )
    ).status,
    401,
  );
});

test("successful fallback waits for abandoned work; deadline covers the drain", async () => {
  const gate = admission({ deadlineMs: 20 });
  const release = Promise.withResolvers<void>();
  const run = gate.run(request(), async () => {
    reportRequestDependencyInterruption(new Error("optional timeout"));
    void trackRequestWork(release.promise);
    return new Response("fallback");
  });
  assert.equal((await run).status, 504);
  assert.equal(gate.stats.active, 1);
  release.resolve();
  await gate.idle();
});

test("request and response caps count bytes and preserve HEAD/null bodies", async () => {
  const gate = admission({ bodyLimitBytes: 3, responseLimitBytes: 3 });
  let starts = 0;
  const execute = async () => {
    starts++;
    return new Response("ok");
  };
  assert.equal(
    (
      await gate.run(
        new Request(request(), { method: "POST", body: "four" }),
        execute,
      )
    ).status,
    413,
  );
  assert.equal(starts, 0);
  assert.equal(
    (
      await gate.run(
        new Request(request(), { method: "POST", body: "éé" }),
        execute,
      )
    ).status,
    413,
  );
  assert.equal(starts, 0);
  assert.equal(
    (await gate.run(request(), async () => new Response("four"))).status,
    500,
  );
  assert.equal(
    (await gate.run(request(), async () => new Response("éé"))).status,
    500,
  );
  assert.equal(
    (await gate.run(new Request(request(), { method: "HEAD" }), execute)).body,
    null,
  );
  assert.equal(
    (await gate.run(request(), async () => new Response(null, { status: 204 })))
      .status,
    204,
  );
});

test(
  "Node response backpressure retains admission until the write deadline closes the transport",
  { timeout: 5000 },
  async (t) => {
    const gate = admission({
      deadlineMs: 500,
      responseLimitBytes: 32 * 1024 * 1024,
    });
    const writing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let finishes = 0;
    let closes = 0;
    const server = createNodeHttpServer((req) =>
      gate.run(req, async () => new Response(new Uint8Array(32 * 1024 * 1024))),
    );
    const address = await server.listen({ hostname: "127.0.0.1", port: 0 });
    server.server.on("request", (_req, res) => {
      res.once("finish", () => finishes++);
      res.once("close", () => {
        closes++;
        closed.resolve();
      });
      // Observe the real Node buffer, not the Fetch handler's return.
      const write = res.write.bind(res);
      res.write = ((...args: Parameters<typeof res.write>) => {
        const result = write(...args);
        if (!result) writing.resolve();
        return result;
      }) as typeof res.write;
    });
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => {});
    socket.pause();
    t.after(async () => {
      socket.destroy();
      gate.abort();
      await server.close();
      await gate.idle();
    });
    socket.write("GET /ap/notes/large HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await writing.promise;
    assert.equal(finishes, 0);
    assert.equal(gate.stats.active, 1);
    assert.equal(
      (await gate.run(request(), async () => new Response())).status,
      503,
    );
    await closed.promise;
    await gate.idle();
    assert.equal(finishes, 0);
    assert.equal(closes, 1);
    assert.equal(gate.stats.timedOut, 1);
    assert.equal(gate.stats.completed, 1);
    assert.equal(gate.stats.active, 0);
  },
);

test(
  "a finished Node timeout response does not release unfinished dependency work",
  { timeout: 5000 },
  async (t) => {
    const gate = admission({ deadlineMs: 20 });
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const server = createNodeHttpServer((req) =>
      gate.run(req, async () => {
        await release.promise;
        return new Response("late");
      }),
    );
    const address = await server.listen({ hostname: "127.0.0.1", port: 0 });
    server.server.on("request", (_req, res) =>
      res.once("finish", () => finished.resolve()),
    );
    t.after(async () => {
      release.resolve();
      await server.close();
      await gate.idle();
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/ap/inbox`);
    assert.equal(response.status, 504);
    await response.text();
    await finished.promise;
    assert.equal(gate.stats.active, 1);
    release.resolve();
    await gate.idle();
    assert.equal(gate.stats.completed, 1);
  },
);

test("stalled response cancellation retains the permit until cancellation settles", async () => {
  const gate = admission({ deadlineMs: 20 });
  const cancel = Promise.withResolvers<void>();
  let cancelled = false;
  const run = gate.run(
    request(),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return cancel.promise;
          },
        }),
      ),
  );
  assert.equal((await run).status, 504);
  assert.equal(cancelled, true);
  assert.equal(gate.stats.active, 1);
  cancel.resolve();
  await gate.idle();
});

test(
  "Node disconnect retains unfinished work and releases admission exactly once",
  { timeout: 5000 },
  async (t) => {
    const gate = admission();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = createNodeHttpServer((req) =>
      gate.run(req, async () => {
        entered.resolve();
        await release.promise;
        return new Response("late");
      }),
    );
    const address = await server.listen({ hostname: "127.0.0.1", port: 0 });
    server.server.on("request", (_req, res) =>
      res.once("close", () => closed.resolve()),
    );
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => {});
    t.after(async () => {
      socket.destroy();
      release.resolve();
      await server.close();
      await gate.idle();
    });
    socket.write("GET /ap/notes/private HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await entered.promise;
    socket.destroy();
    await closed.promise;
    assert.equal(gate.stats.active, 1);
    assert.equal(gate.stats.cancelled, 1);
    release.resolve();
    await gate.idle();
    assert.equal(gate.stats.active, 0);
    assert.equal(gate.stats.completed, 1);
  },
);

test("raw HTTP slow uploads receive a timeout before socket cleanup; excess never reads a body", async (t) => {
  const gate = admission({ deadlineMs: 50 });
  let starts = 0;
  const server = createNodeHttpServer((req) =>
    gate.run(req, async () => {
      starts++;
      return new Response("ok");
    }),
  );
  const address = await server.listen({ hostname: "127.0.0.1", port: 0 });
  t.after(async () => {
    gate.abort();
    await server.close();
    await gate.idle();
  });
  function slow(): { reply: Promise<number>; close: () => void } {
    let client: ReturnType<typeof httpRequest>;
    const reply = new Promise<number>((resolve, reject) => {
      client = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/ap/inbox",
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      client.on("error", reject);
      client.write("{");
    });
    return { reply, close: () => client.destroy() };
  }
  const first = slow();
  t.after(first.close);
  // Wait for actual admission, not a guessed sleep before opening excess.
  await new Promise<void>((resolve, reject) => {
    const until = Date.now() + 1000;
    const check = (): void | Promise<void> =>
      gate.stats.active === 1
        ? resolve()
        : Date.now() >= until
          ? reject(Error("not admitted"))
          : setImmediate().then(check);
    void check();
  });
  const second = slow();
  t.after(second.close);
  assert.equal(await second.reply, 503);
  assert.equal(await first.reply, 504);
  await gate.idle();
  assert.equal(starts, 0);
  assert.equal(gate.stats.active, 0);
});

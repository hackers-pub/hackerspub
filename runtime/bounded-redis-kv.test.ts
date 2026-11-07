import {
  getRequestWorkOutcome,
  runWithRequestWork,
} from "@hackerspub/models/request-work";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import test, { mock } from "node:test";
import { Redis } from "ioredis";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { createBoundedRedisKvStore } from "./bounded-redis-kv.ts";
import {
  createProtocolKvStore,
  createProtocolLoaders,
} from "./protocol-loaders.ts";

/** Real TCP/RESP fixture: answer handshake, then stop replying to commands. */
async function redisFixture() {
  const sockets = new Set<Socket>();
  const commands: string[][] = [];
  let stalled = false;
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      while (true) {
        const header = /^\*(\d+)\r\n/.exec(buffer);
        if (header == null) return;
        let offset = header[0].length;
        const args: string[] = [];
        for (let index = 0; index < Number(header[1]); index++) {
          const length = /^\$(\d+)\r\n/.exec(buffer.slice(offset));
          if (length == null) return;
          offset += length[0].length;
          const end = offset + Number(length[1]);
          if (buffer.length < end + 2) return;
          args.push(buffer.slice(offset, end));
          offset = end + 2;
        }
        buffer = buffer.slice(offset);
        const command = args[0].toLowerCase();
        if (command === "client" || command === "select")
          socket.write("+OK\r\n");
        else if (command === "info") socket.write("$0\r\n\r\n");
        else {
          commands.push(args);
          if (!stalled) socket.write(command === "get" ? "$-1\r\n" : "+OK\r\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address != null && typeof address !== "string");
  return {
    url: new URL(`redis://127.0.0.1:${address.port}`),
    commands,
    sockets,
    connections: () => connections,
    stall: (value: boolean) => {
      stalled = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test(
  "stalled Redis reads and uncertain writes close their actual socket without replay",
  { timeout: 5000 },
  async () => {
    const fixture = await redisFixture();
    const resource = createBoundedRedisKvStore(fixture.url, 100);
    try {
      assert.equal(await resource.kv.get(["warmup"]), undefined);
      fixture.stall(true);
      let interrupted = false;
      const started = performance.now();
      await runWithRequestWork(new AbortController().signal, async () => {
        const results = await Promise.allSettled([
          resource.kv.get(["stalled"]),
          resource.kv.set(["uncertain"], "value"),
        ]);
        assert.equal(results[0].status, "rejected");
        assert.equal(results[1].status, "rejected");
        interrupted = getRequestWorkOutcome().dependencyInterrupted;
      });
      assert(interrupted);
      assert(performance.now() - started < 1500);
      await delay(20);
      assert.equal(fixture.sockets.size, 0);
      assert.equal(fixture.connections(), 1);
      assert.equal(
        fixture.commands.filter(([name]) => name === "set").length,
        1,
      );
      fixture.stall(false);
      assert.equal(await resource.kv.get(["new-request"]), undefined);
      assert.equal(fixture.connections(), 2);
      assert.equal(
        fixture.commands.filter(([name]) => name === "set").length,
        1,
      );
    } finally {
      await resource.close();
      await fixture.close();
    }
  },
);

test(
  "blackholed cache releases all eight loader owners and drains request work",
  { timeout: 5000 },
  async () => {
    const fixture = await redisFixture();
    const resource = createBoundedRedisKvStore(fixture.url, 100);
    const loaders = createProtocolLoaders({
      kv: createProtocolKvStore(resource.kv),
      limit: 8,
      timeoutMs: 50,
    });
    try {
      await resource.kv.get(["warmup"]);
      fixture.stall(true);
      const loader = loaders.options.documentLoaderFactory();
      await runWithRequestWork(new AbortController().signal, async () => {
        const pending = Array.from({ length: 8 }, (_, i) =>
          loader(`https://actor.example/${i}`),
        );
        const settled = Promise.allSettled(pending);
        await setImmediate();
        assert.equal(loaders.stats().active, 8);
        await assert.rejects(
          loader("https://actor.example/overflow"),
          /capacity exhausted/,
        );
        await delay(70);
        // The HTTP timeout has fired; actual Redis commands still own all slots.
        assert.equal(loaders.stats().active, 8);
        assert.equal(fixture.sockets.size, 1);
        const results = await settled;
        assert(results.every((result) => result.status === "rejected"));
      });
      assert.equal(loaders.stats().active, 0);
      await delay(20);
      assert.equal(fixture.sockets.size, 0);
    } finally {
      await resource.close();
      await fixture.close();
    }
  },
);

test(
  "a request aborted while the previous Redis generation drains starts no new work",
  { timeout: 5000 },
  async () => {
    const fixture = await redisFixture();
    const resource = createBoundedRedisKvStore(fixture.url, 100);
    const disconnect = Redis.prototype.disconnect;
    let waitingRequest: Promise<void> | undefined;
    let intercepted = false;
    const disconnectMock = mock.method(
      Redis.prototype,
      "disconnect",
      function (this: Redis, ...args: Parameters<Redis["disconnect"]>) {
        if (!intercepted) {
          intercepted = true;
          const controller = new AbortController();
          // stop() has marked the generation as stopping, but the real socket has
          // not closed yet. Enter exactly that wait and then abort its owner.
          waitingRequest = assert.rejects(
            runWithRequestWork(controller.signal, () =>
              resource.kv.set(["must-not-write"], "value"),
            ),
            { name: "AbortError" },
          );
          controller.abort();
        }
        return disconnect.apply(this, args);
      },
    );
    try {
      await resource.kv.get(["warmup"]);
      fixture.stall(true);
      await assert.rejects(resource.kv.get(["stalled"]), {
        name: "TimeoutError",
      });
      assert(intercepted);
      assert(waitingRequest != null);
      await waitingRequest;
      assert.equal(fixture.connections(), 1);
      assert.equal(
        fixture.commands.filter(([name]) => name === "set").length,
        0,
      );
    } finally {
      disconnectMock.mock.restore();
      await resource.close();
      await fixture.close();
    }
  },
);

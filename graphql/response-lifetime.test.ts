import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { attachResponseLifetime } from "./response-lifetime.ts";

class TestResponse extends EventEmitter {
  writableFinished = false;
  destroyed = false;
  destroys = 0;

  destroy(): void {
    this.destroyed = true;
    this.destroys++;
    this.emit("close");
  }
}

test("response transmission uses only the remaining monotonic request budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const response = new TestResponse();
  const lifetime = attachResponseLifetime(
    new Request("https://local.example"),
    response,
  );
  let timeouts = 0;
  lifetime.limit(1000, () => timeouts++);
  now = 850;
  lifetime.start(200);
  t.mock.timers.tick(249);
  assert.equal(response.destroys, 0);
  t.mock.timers.tick(1);
  await lifetime.finished;
  assert.equal(response.destroys, 1);
  assert.equal(timeouts, 1);
  t.mock.timers.tick(1000);
  assert.equal(response.destroys, 1);
});

test("expired error replies get at most one second to flush", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const response = new TestResponse();
  const lifetime = attachResponseLifetime(
    new Request("https://local.example"),
    response,
  );
  lifetime.limit(100, () => {});
  now = 101;
  lifetime.start(504);
  t.mock.timers.tick(999);
  assert.equal(response.destroys, 0);
  t.mock.timers.tick(1);
  await lifetime.finished;
  assert.equal(response.destroys, 1);
});

test("finish followed by close cancels the write deadline without destroying again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = new TestResponse();
  const lifetime = attachResponseLifetime(
    new Request("https://local.example"),
    response,
  );
  lifetime.limit(100, () => assert.fail("finished response timed out"));
  lifetime.start(200);
  response.writableFinished = true;
  response.emit("finish");
  response.emit("close");
  await lifetime.finished;
  t.mock.timers.tick(2000);
  assert.equal(response.destroys, 0);
  assert.equal(response.listenerCount("finish"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

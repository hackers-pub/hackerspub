import assert from "node:assert";
import test from "node:test";
import { checkWorkerHeartbeat, startWorkerHeartbeat } from "./worker-health.ts";

test("worker heartbeat stays fresh until stopped", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/worker.health`;
  let now = 1_000;
  try {
    const heartbeat = await startWorkerHeartbeat(path, {
      intervalMilliseconds: 10,
      now: () => now,
    });
    assert.equal(await checkWorkerHeartbeat(path, 100, () => now), true);

    now += 101;
    assert.equal(await checkWorkerHeartbeat(path, 100, () => now), false);

    await heartbeat.refresh();
    assert.equal(await checkWorkerHeartbeat(path, 100, () => now), true);

    await heartbeat.stop();
    assert.equal(await checkWorkerHeartbeat(path, 100, () => now), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

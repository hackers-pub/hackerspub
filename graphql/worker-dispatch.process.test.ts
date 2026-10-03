import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  applicationTaskReceiptTable,
  outboxEventTable,
  scheduledWorkerDispatchTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { waitForTaskCondition } from "../test/application-tasks.ts";
import { db } from "../test/database.ts";
import { withExclusiveTestDatabase } from "../test/postgres.ts";

function start(role: "producer" | "worker", jobId: string, pause = "") {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "temporal-polyfill/global",
      "test/scheduled-task-process.ts",
      role,
      jobId,
    ],
    {
      env: { ...process.env, SCHEDULED_PROCESS_PAUSE: pause },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const states = new Set<string>();
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  child.on("message", (message) => {
    if (typeof message === "object" && message != null && "state" in message)
      states.add(String(message.state));
  });
  return {
    child,
    states,
    exited: once(child, "exit"),
    get output() {
      return output;
    },
  };
}

for (const pause of ["before", "after"]) {
  test(`scheduled intent survives SIGKILL ${pause} side effect and completes once after restart`, async () => {
    await withExclusiveTestDatabase(async () => {
      const jobId = generateUuidV7();
      const children: ReturnType<typeof start>[] = [];
      try {
        const producer = start("producer", jobId);
        children.push(producer);
        assert.equal((await producer.exited)[0], 0, producer.output);
        const [intent] = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        assert.equal(intent.status, "pending");
        assert.equal(
          (await db.select().from(scheduledWorkerDispatchTable)).length,
          1,
        );
        const first = start("worker", jobId, pause);
        children.push(first);
        await waitForTaskCondition(async () =>
          first.states.has(pause === "before" ? "executing" : "persisted"),
        );
        assert(first.child.kill("SIGKILL"));
        await first.exited;
        const [interrupted] = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.id, intent.id));
        assert.equal(interrupted.status, "processing");
        const restarted = start("worker", jobId);
        children.push(restarted);
        await waitForTaskCondition(
          async () =>
            (
              await db
                .select()
                .from(outboxEventTable)
                .where(eq(outboxEventTable.id, intent.id))
            )[0].status === "completed",
        );
        assert.equal(
          (
            await db
              .select()
              .from(applicationTaskReceiptTable)
              .where(eq(applicationTaskReceiptTable.jobId, jobId))
          ).length,
          1,
        );
        restarted.child.kill("SIGTERM");
        assert.equal((await restarted.exited)[0], 0, restarted.output);
      } finally {
        for (const service of children) {
          if (
            service.child.exitCode == null &&
            service.child.signalCode == null
          )
            service.child.kill("SIGKILL");
          await service.exited;
        }
        await db
          .delete(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        await db.delete(scheduledWorkerDispatchTable);
        await db
          .delete(applicationTaskReceiptTable)
          .where(eq(applicationTaskReceiptTable.jobId, jobId));
      }
    });
  });
}

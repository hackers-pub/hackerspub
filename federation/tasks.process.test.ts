import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  applicationTaskReceiptTable,
  outboxEventTable,
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
      "test/application-task-process.ts",
      role,
      jobId,
    ],
    {
      env: { ...process.env, TASK_PROCESS_PAUSE: pause },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  const states = new Set<string>();
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
  const exited = once(child, "exit");
  return {
    child,
    exited,
    states,
    get output() {
      return output;
    },
  };
}

for (const pause of ["before", "after"]) {
  test(`SIGKILL ${pause} persistence leaves a recoverable intent and one receipt after restart`, async () => {
    await withExclusiveTestDatabase(async () => {
      const jobId = generateUuidV7();
      const children: ReturnType<typeof start>[] = [];
      try {
        const producer = start("producer", jobId);
        children.push(producer);
        const [exitCode] = await producer.exited;
        assert.equal(exitCode, 0, producer.output);
        const [pending] = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        assert.equal(pending.status, "pending");

        const first = start("worker", jobId, pause);
        children.push(first);
        await waitForTaskCondition(async () =>
          first.states.has(pause === "before" ? "executing" : "persisted"),
        );
        assert.equal(first.child.kill("SIGKILL"), true);
        await first.exited;
        const [interrupted] = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.id, pending.id));
        assert.equal(interrupted.status, "processing");
        assert(interrupted.payload);

        const second = start("worker", jobId);
        children.push(second);
        await waitForTaskCondition(
          async () =>
            (
              await db
                .select()
                .from(outboxEventTable)
                .where(eq(outboxEventTable.id, pending.id))
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
        second.child.kill("SIGTERM");
        const [code] = await second.exited;
        assert.equal(code, 0, second.output);
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
        await db
          .delete(applicationTaskReceiptTable)
          .where(eq(applicationTaskReceiptTable.jobId, jobId));
      }
    });
  });
}

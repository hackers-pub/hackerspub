import { applicationTaskReceiptTable } from "@hackerspub/models/schema";
import { applicationTaskProbe } from "@hackerspub/models/tasks";
import { builder } from "./builder.ts";
import { toApplicationContext } from "./context.ts";
import { registerApplicationTask } from "./task-registry.ts";

registerApplicationTask(
  builder,
  applicationTaskProbe,
  toApplicationContext,
  async (context, data) => {
    await context.db
      .insert(applicationTaskReceiptTable)
      .values({ jobId: data.jobId })
      .onConflictDoNothing();
  },
);

import {
  executeArticleTranslation,
  executeArticleSummary,
} from "@hackerspub/models/article";
import { applicationTaskReceiptTable } from "@hackerspub/models/schema";
import {
  applicationTaskProbe,
  articleTranslationTask,
  articleSummaryTask,
  scheduledWorkerTask,
} from "@hackerspub/models/tasks";
import { builder } from "./builder.ts";
import { getFedifyContext, toApplicationContext } from "./context.ts";
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

registerApplicationTask(
  builder,
  articleTranslationTask,
  toApplicationContext,
  executeArticleTranslation,
);
registerApplicationTask(
  builder,
  articleSummaryTask,
  toApplicationContext,
  executeArticleSummary,
);

registerApplicationTask(
  builder,
  scheduledWorkerTask,
  toApplicationContext,
  async (context, data, execution) => {
    const execute = getFedifyContext(context).data.executeScheduledWorkerJob;
    if (execute == null) {
      throw new Error("Scheduled tasks require worker job resources.");
    }
    await execute(data, execution);
  },
);

import { toApplicationContext } from "@hackerspub/federation/context";
import { replayApplicationTask } from "@hackerspub/models/outbox";
import {
  applicationTaskReceiptTable,
  outboxEventTable,
} from "@hackerspub/models/schema";
import { applicationTaskProbe } from "@hackerspub/models/tasks";
import { generateUuidV7, validateUuid } from "@hackerspub/models/uuid";
import {
  getProcessEnvironment,
  loadDatabaseConfig,
  loadGraphqlApiConfig,
} from "@hackerspub/runtime/config";
import {
  createDatabaseResources,
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
} from "@hackerspub/runtime/resources";
import { and, eq } from "drizzle-orm";
import { services } from "../graphql/services.ts";

const action = process.argv[2];
const id =
  process.argv[3] ?? (action === "enqueue" ? generateUuidV7() : undefined);
if (!["enqueue", "receipt", "dead", "replay"].includes(action ?? "")) {
  throw new TypeError(
    "Usage: application-tasks.ts enqueue [job UUID] | receipt <job UUID> | dead | replay <event UUID>",
  );
}
if (action !== "dead" && !validateUuid(id))
  throw new TypeError("A UUID is required.");

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (action === "enqueue") {
  const resources = await createRuntimeResources(
    loadGraphqlApiConfig(getProcessEnvironment(), { allowFileKv: true }),
    "task-probe",
    {
      fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
      federation: { manuallyStartQueue: true },
    },
  );
  try {
    const context = toApplicationContext(
      resources.federation.createContext(resources.config.origin, {
        db: resources.db,
        kv: resources.kv,
        disk: resources.drive.use(),
        models: resources.models,
        services,
      }),
    );
    await context.enqueueTask(applicationTaskProbe, {
      jobId: id as ReturnType<typeof generateUuidV7>,
    });
    print({ jobId: id, state: "enqueued" });
  } finally {
    await resources.close();
  }
} else {
  const { db, postgres } = createDatabaseResources(
    loadDatabaseConfig(getProcessEnvironment()),
  );
  try {
    if (action === "dead") {
      const events = await db
        .select()
        .from(outboxEventTable)
        .where(
          and(
            eq(outboxEventTable.eventType, "application.task"),
            eq(outboxEventTable.status, "dead"),
          ),
        );
      print(
        events.map((event) => ({
          id: event.id,
          taskName: (event.payload as { taskName?: string } | null)?.taskName,
          processingAttempts: event.processingAttempts,
          failed: event.failed,
          lastError: event.lastError,
        })),
      );
    } else if (action === "receipt") {
      print(
        (
          await db
            .select()
            .from(applicationTaskReceiptTable)
            .where(
              eq(
                applicationTaskReceiptTable.jobId,
                id as ReturnType<typeof generateUuidV7>,
              ),
            )
        )[0] ?? null,
      );
    } else {
      print({
        id,
        replayed: await replayApplicationTask(
          db,
          id as ReturnType<typeof generateUuidV7>,
        ),
      });
    }
  } finally {
    await postgres.end();
  }
}

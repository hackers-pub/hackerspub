import { createRequire } from "node:module";
import process from "node:process";

// Isolate the SDK's global provider and module hooks from the test process.
const require = createRequire(import.meta.url);
const Sentry: typeof import("@sentry/node-sdk") =
  process.argv[2] === "cjs"
    ? require("@sentry/node-sdk")
    : await import("@sentry/node-sdk");
const physical = { success: 0, failure: 0 };
const spans = { success: 0, failure: 0 };
Sentry.init({
  dsn: "https://public@example.invalid/1",
  tracesSampleRate: 1,
  defaultIntegrations: false,
  integrations: [
    Sentry.postgresJsIntegration({
      requestHook(_span, statement) {
        if (statement.includes("as sentry_success")) spans.success++;
        if (statement.includes("as sentry_failure")) spans.failure++;
      },
    }),
  ],
  // Never send this fixture's spans or failures to a remote service.
  transport: () => ({
    send: async () => ({ statusCode: 200 }),
    flush: async () => true,
  }),
});
const postgres = require("postgres") as typeof import("postgres");
// The SDK preserves the original constructor as its wrapper's prototype.
// Using it bypasses the sql-instance wrapper and exercises Query.prototype's
// fallback instrumentation instead of the core integration's query marker.
const factory =
  process.argv[3] === "fallback"
    ? (Object.getPrototypeOf(postgres) as typeof postgres)
    : postgres;
const sql = factory(process.env.DATABASE_URL!, {
  max: 1,
  debug(_connection, statement) {
    if (statement.includes("as sentry_success")) physical.success++;
    if (statement.includes("as sentry_failure")) physical.failure++;
  },
});
try {
  await Sentry.startSpan(
    { name: "Repeated query observation", op: "test" },
    async () => {
      const successful = sql`select 1 as sentry_success`;
      const values = await Promise.all([
        successful,
        successful.catch(() => undefined),
        successful.finally(() => {}),
      ]);
      // Observing the result after settlement must not start another span.
      await successful;
      const failed = sql`select sentry_missing_column as sentry_failure`;
      const failures = await Promise.allSettled([
        failed,
        failed.catch((error: Error) => {
          throw error;
        }),
        failed.finally(() => {}),
      ]);
      console.log(
        JSON.stringify({
          physical,
          spans,
          values: values.map((result) => result?.[0]?.sentry_success),
          failures: failures.map((result) =>
            result.status === "rejected"
              ? (result.reason as { code: string }).code
              : "fulfilled",
          ),
        }),
      );
    },
  );
} finally {
  await sql.end();
  await Sentry.close(1000);
}

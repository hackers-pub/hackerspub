import { assertEquals, assertRejects } from "@std/assert";
import {
  drainRequestWork,
  runWithRequestWork,
} from "@hackerspub/models/request-work";
import postgres from "postgres";
import test from "node:test";
import { trackSqlWork } from "./sql-work.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "real PostgreSQL queries remain owned after a sibling fails",
  {
    skip: databaseUrl == null ? "DATABASE_URL is not configured" : false,
    timeout: 10000,
  },
  async () => {
    const sql = trackSqlWork(postgres(databaseUrl!, { max: 2 }));
    try {
      // Use separate, already-established connections to make the fast failure
      // independent of the in-flight sleep query.
      const slowConnection = await sql.reserve();
      const failingConnection = await sql.reserve();
      try {
        let slowFinished = false;
        let sawFailureBeforeSlow = false;
        await assertRejects(() =>
          runWithRequestWork(new AbortController().signal, async () => {
            const slow = slowConnection`select pg_sleep(0.5)`;
            const slowResult = slow.then(() => {
              slowFinished = true;
            });
            // Let the sleep be dispatched before sending the failing query.
            await new Promise((resolve) => setTimeout(resolve, 30));
            try {
              await Promise.all([slowResult, failingConnection`select 1 / 0`]);
            } catch (error) {
              sawFailureBeforeSlow = !slowFinished;
              throw error;
            }
          }),
        );
        assertEquals(sawFailureBeforeSlow, true);
        assertEquals(slowFinished, true);
      } finally {
        slowConnection.release();
        failingConnection.release();
      }
    } finally {
      await sql.end();
    }
  },
);

test(
  "real transaction query work drains inside its callback",
  {
    skip: databaseUrl == null ? "DATABASE_URL is not configured" : false,
    timeout: 10000,
  },
  async () => {
    const sql = trackSqlWork(postgres(databaseUrl!, { max: 2 }));
    try {
      let slowFinished = false;
      await runWithRequestWork(new AbortController().signal, async () => {
        await sql.begin(async (tx) => {
          // The callback receives the transaction-bound client. Its query must
          // drain here; tracking begin() itself would deadlock this drain.
          const pending = tx.unsafe("select pg_sleep(0.1)");
          void pending.then(() => {
            slowFinished = true;
          });
          await drainRequestWork();
          assertEquals(slowFinished, true);
        });
      });
    } finally {
      await sql.end();
    }
  },
);

test(
  "aborting request work cancels a real PostgreSQL sleep and waits for query termination",
  {
    skip: databaseUrl == null ? "DATABASE_URL is not configured" : false,
    timeout: 10000,
  },
  async () => {
    const sql = trackSqlWork(postgres(databaseUrl!, { max: 2 }));
    const abort = new AbortController();
    try {
      // Establish the connection before timing query cancellation.
      await sql`select 1`;
      let querySettled = false;
      let errorCode: unknown;
      const started = performance.now();
      const work = runWithRequestWork(abort.signal, async () => {
        const query = sql`select pg_sleep(5)`;
        void query.then(
          () => {
            querySettled = true;
          },
          (error: unknown) => {
            querySettled = true;
            errorCode = (error as { code?: unknown }).code;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        abort.abort();
      });
      await work;
      assertEquals(querySettled, true);
      assertEquals(errorCode, "57014");
      if (performance.now() - started >= 3000)
        throw new Error("query was not cancelled promptly");
      assertEquals((await sql`select 1 as value`)[0].value, 1);
    } finally {
      await sql.end();
    }
  },
);

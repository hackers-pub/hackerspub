import { assertEquals } from "@std/assert";
import { runWithRequestWork } from "@hackerspub/models/request-work";
import type { Sql } from "postgres";
import { getEventListeners } from "node:events";
import test from "node:test";
import { trackSqlWork } from "./sql-work.ts";

class LazyQuery extends Promise<string> {
  static get [Symbol.species]() {
    return Promise;
  }
  private start: () => void;
  constructor(start: () => Promise<string>) {
    let resolve!: (value: string) => void;
    let reject!: (error: unknown) => void;
    super((a, b) => {
      resolve = a;
      reject = b;
    });
    let started = false;
    this.start = () => {
      if (started) return;
      started = true;
      void start().then(resolve, reject);
    };
  }
  execute() {
    this.start();
    return this;
  }
  then<TResult1 = string, TResult2 = never>(
    onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.start();
    return super.then(onfulfilled, onrejected);
  }
}

test("SQL tracking preserves laziness and drains a sibling after failure", async () => {
  let starts = 0;
  let finish!: () => void;
  const slow = new Promise<string>((resolve) => {
    finish = () => resolve("slow");
  });
  const client = Object.assign(
    () =>
      new LazyQuery(() => {
        starts++;
        return slow;
      }),
    {
      unsafe: () =>
        new LazyQuery(() => {
          starts++;
          return slow;
        }),
    },
  ) as unknown as Sql;
  const sql = trackSqlWork(client);
  const query = sql.unsafe("select slow");
  assertEquals(starts, 0);
  let settled = false;
  const run = runWithRequestWork(new AbortController().signal, async () => {
    void Promise.resolve(query);
    await Promise.resolve();
    throw new Error("sibling failed");
  }).catch(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assertEquals(starts, 1);
  assertEquals(settled, false);
  finish();
  await run;
  assertEquals(settled, true);
});

test("transaction callbacks wrap query clients without tracking the transaction itself", async () => {
  let finish!: () => void;
  const pending = new Promise<string>((resolve) => {
    finish = () => resolve("ok");
  });
  const tx = Object.assign(() => new LazyQuery(() => pending), {
    unsafe: () => new LazyQuery(() => pending),
  });
  const root = Object.assign(() => new LazyQuery(() => pending), {
    begin: (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  }) as unknown as Sql;
  const sql = trackSqlWork(root);
  let finished = false;
  const run = runWithRequestWork(new AbortController().signal, async () => {
    return await sql.begin(async (transaction) => {
      void Promise.resolve(transaction.unsafe("select slow"));
      await Promise.resolve();
      const { drainRequestWork } =
        await import("@hackerspub/models/request-work");
      await drainRequestWork();
    });
  }).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assertEquals(finished, false);
  finish();
  await run;
  assertEquals(finished, true);
});

test("cancellation failure retains ownership and removes the abort listener on settlement", async () => {
  let finish!: () => void;
  let cancellations = 0;
  const pending = new Promise<string>((resolve) => {
    finish = () => resolve("done");
  });
  const query = Object.assign(new LazyQuery(() => pending), {
    canceller: () => {
      cancellations++;
      return Promise.reject(new Error("cancel failed"));
    },
    cancel() {
      this.canceller();
    },
  });
  const client = Object.assign(() => query, {
    unsafe: () => query,
  }) as unknown as Sql;
  const sql = trackSqlWork(client);
  const abort = new AbortController();
  let scopeSettled = false;
  const scope = runWithRequestWork(abort.signal, async () => {
    void Promise.resolve(sql.unsafe("select slow"));
    await Promise.resolve();
    abort.abort();
  }).then(() => {
    scopeSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assertEquals(cancellations, 1);
  assertEquals(scopeSettled, false);
  finish();
  await scope;
  assertEquals(getEventListeners(abort.signal, "abort").length, 0);
});

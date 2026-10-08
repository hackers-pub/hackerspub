import { PostgresMessageQueue } from "@fedify/postgres";
import assert from "node:assert/strict";
import { test } from "node:test";

test("Postgres queue retries initialization after a shared transient failure", async () => {
  const failure = Object.assign(new Error("statement timeout"), {
    name: "PostgresError",
    code: "57014",
  });
  let statements = 0;
  let rejectInitialization: (error: Error) => void = () => {
    throw new Error("Initialization has not started");
  };
  const pending = new Promise<never>((_, reject) => {
    rejectInitialization = reject;
  });
  const sql = Object.assign(
    (strings: TemplateStringsArray | string) => {
      if (!Array.isArray(strings)) return strings;
      statements++;
      if (statements === 1) return pending;
      return Promise.resolve([{ test: '{"foo":1}' }]);
    },
    { json: (value: unknown) => value },
  );
  const queue = new PostgresMessageQueue(
    sql as unknown as ConstructorParameters<typeof PostgresMessageQueue>[0],
  );

  const first = queue.initialize();
  const concurrent = queue.initialize();
  const failed = Promise.all([
    assert.rejects(first, (error: unknown) => error === failure),
    assert.rejects(concurrent, (error: unknown) => error === failure),
  ]);
  assert.equal(statements, 1);
  rejectInitialization(failure);
  await failed;

  await queue.initialize();
  assert.ok(statements > 1);
  const initializedStatements = statements;
  await queue.initialize();
  assert.equal(statements, initializedStatements);
});

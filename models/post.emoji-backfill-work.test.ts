import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { DocumentLoader } from "@fedify/fedify";
import { Collection, Like, Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import type { AfterCommitTask } from "./context.ts";
import type { Transaction } from "./db.ts";
import { persistPost } from "./post/remote.ts";
import { runWithRequestWork } from "./request-work.ts";
import {
  createFedCtx,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

async function prepareBackfill(tx: Transaction) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const author = await insertRemoteActor(tx, {
    username: `emojiwork${suffix}`,
    name: "Backfill work",
    host: "emoji-work.example",
  });
  const post = new Note({
    id: new URL(`https://emoji-work.example/posts/${suffix}`),
    attribution: new URL(author.iri),
    to: PUBLIC_COLLECTION,
    content: "Backfill request ownership",
    emojiReactions: new URL(`https://emoji-work.example/reactions/${suffix}`),
  });
  const context = {
    ...createFedCtx(tx),
    rootDb: tx,
    afterCommit: [] as AfterCommitTask[],
  };
  return { context, post, author };
}

async function runAfterCommit(tasks: AfterCommitTask[]): Promise<void> {
  for (const task of tasks) await task();
}

test("request-owned emoji backfill does not retain a failed attempt through the retry delay", async (t) => {
  await withRollback(async (tx) => {
    const { context, post } = await prepareBackfill(tx);
    let attempts = 0;
    post.getEmojiReactions = async () => {
      attempts++;
      if (attempts === 1) t.mock.timers.enable({ apis: ["setTimeout"] });
      throw new Error("Backfill unavailable");
    };
    assert.ok(await persistPost(context, post, { replies: false }));
    let finished = false;
    const running = runWithRequestWork(new AbortController().signal, () =>
      runAfterCommit(context.afterCommit),
    ).then(() => {
      finished = true;
    });
    try {
      // Draining uses setImmediate, independently of the mocked retry timer.
      for (let i = 0; i < 5 && !finished; i++) await setImmediate();
      assert.equal(finished, true);
      assert.equal(attempts, 1);
      t.mock.timers.tick(30_000);
      await setImmediate();
      assert.equal(attempts, 1);
    } finally {
      t.mock.timers.tick(30_000);
      await running;
    }
  });
});

test("background emoji backfill retains its delayed retry", async (t) => {
  await withRollback(async (tx) => {
    const { context, post } = await prepareBackfill(tx);
    const retried = Promise.withResolvers<void>();
    let attempts = 0;
    post.getEmojiReactions = async () => {
      attempts++;
      if (attempts === 1) {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        throw new Error("First attempt unavailable");
      }
      retried.resolve();
      return null;
    };
    assert.ok(await persistPost(context, post, { replies: false }));
    await runAfterCommit(context.afterCommit);
    await setImmediate();
    assert.equal(attempts, 1);
    t.mock.timers.tick(29_999);
    await setImmediate();
    assert.equal(attempts, 1);
    t.mock.timers.tick(1);
    await retried.promise;
    await setImmediate();
    assert.equal(attempts, 2);
  });
});

for (const loading of ["document", "context"] as const) {
  test(`request cancellation reaches the emoji backfill ${loading} loader`, async () => {
    await withRollback(async (tx) => {
      const { context, post } = await prepareBackfill(tx);
      const cancel = new AbortController();
      const started = Promise.withResolvers<void>();
      const abort = Promise.withResolvers<void>();
      const finish =
        Promise.withResolvers<Awaited<ReturnType<DocumentLoader>>>();
      let observed: AbortSignal | undefined;
      let calls = 0;
      const waitingLoader: DocumentLoader = async (_url, options) => {
        calls++;
        observed = options?.signal;
        started.resolve();
        observed?.addEventListener(
          "abort",
          () => {
            abort.resolve();
            finish.reject(observed?.reason);
          },
          { once: true },
        );
        return await finish.promise;
      };
      const documentLoader: DocumentLoader =
        loading === "document"
          ? waitingLoader
          : async (url) => ({
              contextUrl: null,
              documentUrl: url,
              document: {
                "@context": "https://emoji-work.example/context",
                id: url,
                type: "Collection",
                items: [],
              },
            });
      assert.ok(
        await persistPost(context, post, {
          replies: false,
          documentLoader,
          contextLoader: loading === "context" ? waitingLoader : undefined,
        }),
      );
      const running = runWithRequestWork(cancel.signal, () =>
        runAfterCommit(context.afterCommit),
      );
      try {
        await started.promise;
        assert.ok(observed);
        assert.equal(observed.aborted, false);
        cancel.abort();
        assert.equal(observed.aborted, true);
        await abort.promise;
        await running;
        assert.equal(calls, 1);
      } finally {
        cancel.abort();
        finish.reject(cancel.signal.reason);
        await running;
      }
    });
  });
}

test("emoji backfill stops before processing an item yielded after cancellation", async () => {
  await withRollback(async (tx) => {
    const { context, post, author } = await prepareBackfill(tx);
    const cancel = new AbortController();
    const collection = new Collection({});
    let consumed = 0;
    collection.getItems = async function* () {
      cancel.abort();
      yield new Like({
        id: new URL("https://emoji-work.example/likes/cancelled"),
        actor: new URL(author.iri),
        object: post.id,
        content: "❤️",
      });
      consumed++;
    };
    post.getEmojiReactions = async () => collection;
    const persisted = await persistPost(context, post, { replies: false });
    assert.ok(persisted);
    await runWithRequestWork(cancel.signal, () =>
      runAfterCommit(context.afterCommit),
    );
    assert.equal(consumed, 0);
    assert.deepEqual(
      await tx.query.reactionTable.findMany({
        where: { postId: persisted.id },
      }),
      [],
    );
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Note, PUBLIC_COLLECTION } from "@fedify/vocab";
import { persistPost } from "@hackerspub/models/post/remote";
import { runWithRequestWork } from "@hackerspub/models/request-work";
import { recomputeNewsScores } from "@hackerspub/models/news";
import { postLinkTable, postTable } from "@hackerspub/models/schema";
import { createMemoryAnonymousReadStore } from "@hackerspub/runtime/anonymous-read-admission";
import { loadAnonymousReadConfig } from "@hackerspub/runtime/config";
import { AnonymousReadController } from "./anonymous-reads.ts";
import { createYogaServer } from "./server.ts";
import { publicReadDocuments } from "./public-read-documents.ts";
import {
  createFedCtx,
  insertRemoteActor,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

function controller(options = {}) {
  const config = {
    ...loadAnonymousReadConfig({}),
    localLimit: 1,
    globalLimit: 1,
    joinWindowMs: 1000,
    ...options,
  };
  return new AnonymousReadController(
    createMemoryAnonymousReadStore(config.globalLimit),
    config,
  );
}

async function relayText(name: string): Promise<string> {
  const source = await readFile(
    new URL(
      `../web-next/src/__generated__/${name}.graphql.ts`,
      import.meta.url,
    ),
    "utf8",
  );
  const match = /"text":\s*("(?:\\.|[^"\\])*")/.exec(source);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("real guest news documents share a snapshot, keep moderator data private and refresh restricted/deleted content", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "admissionnews",
      name: "Admission News",
      email: "admissionnews@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://admission.example/story",
      title: "Public title",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      link: { id: link.id, url: link.url },
    });
    await recomputeNewsScores(tx);
    await tx
      .update(postLinkTable)
      .set({ scorePenalty: 1 })
      .where(eq(postLinkTable.id, link.id));
    const admission = controller();
    const yoga = createYogaServer(admission);
    let transactions = 0;
    let block = true;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const countedDb = new Proxy(tx, {
      get(target, property) {
        if (property === "transaction")
          return async (...args: Parameters<typeof target.transaction>) => {
            transactions++;
            if (block) {
              entered.resolve();
              await release.promise;
            }
            return await target.transaction(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fetch = async (
      query = publicReadDocuments[0],
      headers: HeadersInit = {},
    ) => {
      const req = new Request("http://localhost/graphql?no-propagate=true", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query, variables: { order: "NEWEST" } }),
      });
      return yoga.fetch(req, makeGuestContext(countedDb, { request: req }));
    };
    try {
      const first = fetch();
      await entered.promise;
      const second = fetch();
      await setImmediate();
      assert.equal(admission.stats.shared, 1);
      assert.equal(transactions, 1);
      // A genuine generated login layout query must avoid the busy DB lane.
      const layout = await (
        await fetch(await relayText("RootLayoutQuery"))
      ).json();
      assert.equal(layout.errors, undefined);
      assert.equal(layout.data.viewer, null);
      assert.equal(transactions, 1);
      const distinct = await fetch(publicReadDocuments[1]);
      assert.equal(distinct.status, 503);
      block = false;
      release.resolve();
      const [a, b] = await Promise.all([
        first.then((r) => r.json()),
        second.then((r) => r.json()),
      ]);
      assert.equal(a.errors, undefined);
      assert.deepEqual(a, b);
      assert.equal(a.data.viewer, null);
      const story = a.data.newsStories.edges.find(
        (edge: { node: { url: string } }) => edge.node.url === link.url,
      );
      assert.ok(story);
      assert.equal(story.node.penalty, null);
      assert.equal(transactions, 1);
      // No completed response is retained; a new snapshot sees a restriction.
      await tx
        .update(postTable)
        .set({ visibility: "followers" })
        .where(eq(postTable.id, post.id));
      // Direct fixture writes bypass the application rescore hooks. Refresh
      // the existing derived news index before asserting its removal policy.
      await recomputeNewsScores(tx);
      const restricted = await (await fetch()).json();
      assert.equal(restricted.errors, undefined);
      assert.equal(
        restricted.data.newsStories.edges.some(
          (edge: { node: { url: string } }) => edge.node.url === link.url,
        ),
        false,
      );
      assert.equal(transactions, 2);
      await tx.delete(postTable).where(eq(postTable.id, post.id));
      await recomputeNewsScores(tx);
      const deleted = await (await fetch()).json();
      assert.equal(deleted.errors, undefined);
      assert.equal(
        deleted.data.newsStories.edges.some(
          (edge: { node: { url: string } }) => edge.node.url === link.url,
        ),
        false,
      );
      assert.equal(transactions, 3);
    } finally {
      release.resolve();
      await yoga.dispose();
    }
  });
});

test("forged-session lookup flood cannot take the credential-free sign-in lane or bypass guest admission", async () => {
  await withRollback(async (tx) => {
    const admission = controller({ authLimit: 1 });
    const yoga = createYogaServer(admission);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let lookups = 0;
    const context = makeGuestContext(tx);
    const get = context.kv.get.bind(context.kv);
    context.kv.get = (async (...args: unknown[]) => {
      lookups++;
      entered.resolve();
      await release.promise;
      return await Reflect.apply(get, context.kv, args);
    }) as typeof context.kv.get;
    const fetch = async (query: string, authorization?: string) => {
      const req = new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization == null ? {} : { authorization }),
        },
        body: JSON.stringify({ query }),
      });
      return yoga.fetch(req, { ...context, request: req });
    };
    const layoutQuery = await relayText("RootLayoutQuery");
    try {
      const first = fetch(layoutQuery, `Bearer ${crypto.randomUUID()}`);
      await entered.promise;
      const blocked = await fetch(layoutQuery, `Bearer ${crypto.randomUUID()}`);
      assert.equal(blocked.status, 503);
      assert.equal(lookups, 1);
      const anonymous = await (await fetch(layoutQuery)).json();
      assert.equal(anonymous.errors, undefined);
      assert.equal(anonymous.data.viewer, null);
      release.resolve();
      assert.equal((await (await first).json()).data.viewer, null);
      assert.equal(admission.stats.authentication, 0);
    } finally {
      release.resolve();
      await yoga.dispose();
    }
  });
});

test("guest-triggered after-commit reaction backfill retains its admission slot", async () => {
  await withRollback(async (tx) => {
    const actor = await insertRemoteActor(tx, {
      username: "admissionbackfill",
      name: "Backfill",
      host: "backfill.example",
    });
    const post = new Note({
      id: new URL("https://backfill.example/posts/owned"),
      attribution: new URL(actor.iri),
      to: PUBLIC_COLLECTION,
      content: "Owned backfill",
    });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<null>();
    post.getEmojiReactions = async () => {
      started.resolve();
      return await finish.promise;
    };
    const admission = controller();
    const cancellation = new AbortController();
    const context = {
      ...createFedCtx(tx),
      rootDb: tx,
      afterCommit: [] as Array<() => Promise<void> | void>,
    };
    const request = new Request("http://localhost/graphql", {
      signal: cancellation.signal,
    });
    const executionFinished = Promise.withResolvers<void>();
    const running = admission.run(request, undefined, (req) =>
      runWithRequestWork(req.signal, async () => {
        assert.ok(await persistPost(context, post, { replies: false }));
        for (const task of context.afterCommit) await task();
      }).finally(() => executionFinished.resolve()),
    );
    try {
      await started.promise;
      await setImmediate();
      assert.equal(admission.stats.active, 1);
      await assert.rejects(async () =>
        admission.run(new Request(request.url), undefined, async () => {}),
      );
      cancellation.abort();
      await assert.rejects(running, { name: "AbortError" });
      // This dependency deliberately ignores cancellation. Ownership cannot
      // end until its real external operation does, even after afterCommit.
      assert.equal(admission.stats.active, 1);
    } finally {
      finish.resolve(null);
      await Promise.allSettled([running]);
      await executionFinished.promise;
      await setImmediate();
    }
    assert.equal(admission.stats.active, 0);
  });
});

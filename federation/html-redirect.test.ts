import assert from "node:assert";
import test from "node:test";
import { MemoryKvStore } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import { createQuestion } from "@hackerspub/models/question";
import {
  actorTable,
  articleSourceTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { builder } from "./builder.ts";
import { acceptsHtml, handleNotAcceptable } from "./html-redirect.ts";
import "./mod.ts";
import {
  createFedCtx,
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  services,
  withRollback,
} from "../test/postgres.ts";

type Transaction = Parameters<Parameters<typeof withRollback>[0]>[0];

async function createFetch(
  tx: Transaction,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const federation = await builder.build({
    kv: new MemoryKvStore(),
    origin: "http://localhost/",
  });
  const contextData: ContextData = {
    db: tx,
    kv: createTestKv().kv,
    disk: createTestDisk(),
    models: {} as ContextData["models"],
    services,
  };
  return (path, init) =>
    federation.fetch(new Request(`http://localhost${path}`, init), {
      contextData,
      onNotAcceptable: (request) =>
        handleNotAcceptable(
          federation.createContext(request, contextData),
          request,
        ),
    });
}

const html = { headers: { Accept: "text/html" } };

function assertSeeOther(response: Response, location: string): void {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), location);
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
}

test("acceptsHtml() lets the most specific range decide", () => {
  assert.equal(acceptsHtml(null), true);
  assert.equal(acceptsHtml(""), true);
  assert.equal(acceptsHtml("*/*"), true);
  assert.equal(acceptsHtml("text/*"), true);
  assert.equal(acceptsHtml("text/html,application/xhtml+xml,*/*;q=0.8"), true);
  assert.equal(acceptsHtml("TEXT/HTML; charset=utf-8; q=0.5"), true);
  assert.equal(acceptsHtml("image/png"), false);
  assert.equal(acceptsHtml("text/plain"), false);
  assert.equal(acceptsHtml("text/html;q=0"), false);
  assert.equal(acceptsHtml("*/*, text/html;q=0"), false);
  assert.equal(acceptsHtml("text/*;q=0, */*"), false);
  assert.equal(acceptsHtml("text/html;q=0.1, text/*;q=0"), true);
  assert.equal(acceptsHtml("text/html;q=bogus"), false);
});

test("handleNotAcceptable() redirects note IRIs to their permalinks", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "htmlredirectnote",
      name: "HTML Redirect Note",
      email: "htmlredirectnote@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Redirect me",
    });
    const { noteSourceId: privateId, post: privatePost } = await insertNotePost(
      tx,
      {
        account: author.account,
        visibility: "followers",
        content: "Redirect me too",
      },
    );
    const fetch = await createFetch(tx);

    assertSeeOther(await fetch(`/ap/notes/${noteSourceId}`, html), post.url!);
    assertSeeOther(await fetch(`/ap/notes/${noteSourceId}`), post.url!);
    assertSeeOther(
      await fetch(`/ap/notes/${noteSourceId}`, {
        headers: { Accept: "*/*" },
      }),
      post.url!,
    );
    // The HTML permalink enforces visibility, so non-public notes redirect too.
    assertSeeOther(
      await fetch(`/ap/notes/${privateId}`, html),
      privatePost.url!,
    );

    const head = await fetch(`/ap/notes/${noteSourceId}`, {
      method: "HEAD",
      ...html,
    });
    assertSeeOther(head, post.url!);
    assert.equal(await head.text(), "");

    const json = await fetch(`/ap/notes/${noteSourceId}`, {
      headers: { Accept: "application/activity+json" },
    });
    assert.equal(json.status, 200);
    assert.equal(
      (await json.json()).id,
      `http://localhost/ap/notes/${noteSourceId}`,
    );

    for (const accept of ["image/png", "text/html;q=0"]) {
      const response = await fetch(`/ap/notes/${noteSourceId}`, {
        headers: { Accept: accept },
      });
      assert.equal(response.status, 406, accept);
    }
  });
});

test("handleNotAcceptable() does not redirect hidden or unknown posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "htmlredirecthidden",
      name: "HTML Redirect Hidden",
      email: "htmlredirecthidden@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Censored",
    });
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.id));
    const banned = await insertAccountWithActor(tx, {
      username: "htmlredirectbanned",
      name: "HTML Redirect Banned",
      email: "htmlredirectbanned@example.com",
    });
    await tx
      .update(actorTable)
      .set({ suspended: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(actorTable.id, banned.actor.id));
    const { noteSourceId: bannedNoteSourceId } = await insertNotePost(tx, {
      account: banned.account,
      content: "Banned author",
    });
    const suspended = await insertAccountWithActor(tx, {
      username: "htmlredirectsuspended",
      name: "HTML Redirect Suspended",
      email: "htmlredirectsuspended@example.com",
    });
    await tx
      .update(actorTable)
      .set({
        suspended: new Date("2026-01-01T00:00:00.000Z"),
        suspendedUntil: new Date("2999-01-01T00:00:00.000Z"),
      })
      .where(eq(actorTable.id, suspended.actor.id));
    const { noteSourceId: suspendedNoteSourceId, post: suspendedPost } =
      await insertNotePost(tx, {
        account: suspended.account,
        content: "Temporarily suspended author",
      });
    const fetch = await createFetch(tx);

    // A temporary suspension only restricts writing, so the post stays
    // visible and the redirect still applies.
    assertSeeOther(
      await fetch(`/ap/notes/${suspendedNoteSourceId}`, html),
      suspendedPost.url!,
    );
    for (const path of [
      `/ap/notes/${noteSourceId}`,
      `/ap/notes/${bannedNoteSourceId}`,
      `/ap/notes/${generateUuidV7()}`,
      "/ap/notes/not-a-uuid",
      "/ap/questions/not-a-uuid",
      "/ap/articles/not-a-uuid",
      "/ap/actors/not-a-uuid",
    ]) {
      const response = await fetch(path, html);
      assert.equal(response.status, 406, path);
      assert.equal(response.headers.get("Location"), null, path);
    }
  });
});

test("handleNotAcceptable() redirects question and article IRIs", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "htmlredirectposts",
      name: "HTML Redirect Posts",
      email: "htmlredirectposts@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");
    const question = await createQuestion(createFedCtx(tx), {
      accountId: author.account.id,
      visibility: "public",
      quotePolicy: "everyone",
      content: "Redirect this question?",
      language: "en",
      media: [],
      published,
      updated: published,
      poll: {
        title: "Redirect",
        multiple: false,
        options: ["Yes", "No"],
        ends: new Date("2026-04-16T00:00:00.000Z"),
        now: published,
      },
    });
    assert.ok(question?.url != null);

    const articleSourceId = generateUuidV7();
    const articlePostId = generateUuidV7();
    const articleUrl = "http://localhost/@htmlredirectposts/2026/redirect-me";
    await tx.insert(articleSourceTable).values({
      id: articleSourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "redirect-me",
      quotePolicy: "everyone",
      published,
      updated: published,
    });
    await tx.insert(postTable).values({
      id: articlePostId,
      iri: `http://localhost/ap/articles/${articleSourceId}`,
      type: "Article",
      visibility: "public",
      quotePolicy: "everyone",
      actorId: author.actor.id,
      articleSourceId,
      name: "Redirect me",
      contentHtml: "<p>Redirect me</p>",
      language: "en",
      url: articleUrl,
      published,
      updated: published,
    });
    const fetch = await createFetch(tx);

    assertSeeOther(
      await fetch(`/ap/questions/${question.noteSource.id}`, html),
      question.url,
    );
    // A question is not reachable through the note route.
    assert.equal(
      (await fetch(`/ap/notes/${question.noteSource.id}`, html)).status,
      406,
    );
    assertSeeOther(
      await fetch(`/ap/articles/${articleSourceId}`, html),
      articleUrl,
    );
  });
});

test("handleNotAcceptable() redirects only local account actor IRIs", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "htmlredirectactor",
      name: "HTML Redirect Actor",
      email: "htmlredirectactor@example.com",
    });
    const actorUrl = "http://localhost/@htmlredirectactor";
    await tx
      .update(actorTable)
      .set({ url: actorUrl })
      .where(eq(actorTable.id, author.actor.id));
    const fetch = await createFetch(tx);

    assertSeeOther(
      await fetch(`/ap/actors/${author.account.id}`, html),
      actorUrl,
    );
    for (const path of [
      "/ap/actors/localhost",
      `/ap/actors/${author.account.id}/followers`,
      `/ap/actors/${author.account.id}/outbox`,
    ]) {
      assert.equal((await fetch(path, html)).status, 406, path);
    }
    assert.equal(
      (
        await fetch(`/ap/actors/${author.account.id}`, {
          method: "DELETE",
          ...html,
        })
      ).status,
      406,
    );
  });
});

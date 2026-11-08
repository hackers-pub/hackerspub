import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCryptoKeyPair,
  getDocumentLoader,
  MemoryKvStore,
  signRequest,
} from "@fedify/fedify";
import { CryptographicKey, Person } from "@fedify/vocab";
import type { Transaction } from "@hackerspub/models/db";
import {
  actorTable,
  blockingTable,
  customEmojiTable,
  followingTable,
  mentionTable,
  noteSourceTable,
  pollOptionTable,
  pollTable,
  postTable,
  quoteAuthorizationTable,
  reactionTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq, inArray } from "drizzle-orm";
import { builder } from "./builder.ts";
import "./objects.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

const keys = generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
// Use the production object dispatchers with real Fedify HTTP signatures.
// Only actor documents and signing keys are supplied by this local fixture.
builder
  .setActorDispatcher(
    "/ap/actors/{identifier}",
    (ctx, identifier) => new Person({ id: ctx.getActorUri(identifier) }),
  )
  .setKeyPairsDispatcher(async () => [await keys]);
builder.setFollowersDispatcher("/ap/actors/{identifier}/followers", () => ({
  items: [],
}));

async function httpFixture(tx: Transaction) {
  const documents = new Map<string, unknown>();
  const load = async (url: string) => {
    const document = documents.get(url);
    assert.ok(document != null, `Unexpected actor/key lookup: ${url}`);
    return { contextUrl: null, documentUrl: url, document };
  };
  const federation = await builder.build({
    kv: new MemoryKvStore(),
    origin: "http://localhost/",
    contextLoaderFactory: () => getDocumentLoader({ timeout: null }),
    documentLoaderFactory: () => load,
    authenticatedDocumentLoaderFactory: () => load,
  });
  return {
    async fetch(path: string, iri?: string, invalid = false) {
      const url = `http://localhost${path}`;
      let request = new Request(url, {
        headers: { Accept: "application/activity+json" },
      });
      if (iri != null) {
        const pair = await keys;
        const actorId = new URL(iri);
        const keyId = new URL("#key", actorId);
        const document = await new Person({
          id: actorId,
          publicKey: new CryptographicKey({
            id: keyId,
            owner: actorId,
            publicKey: pair.publicKey,
          }),
        }).toJsonLd();
        documents.set(actorId.href, document);
        documents.set(keyId.href, document);
        request = await signRequest(request, pair.privateKey, keyId);
        if (invalid) {
          const headers = new Headers(request.headers);
          headers.set(
            "signature",
            headers
              .get("signature")!
              .replace(/signature="[^"]+"/, 'signature="AAAA"'),
          );
          request = new Request(url, { headers });
        }
      }
      return await federation.fetch(request, {
        contextData: createFedCtx(tx).data,
      });
    },
  };
}

async function targets(tx: Transaction) {
  const author = await insertAccountWithActor(tx, {
    username: "httpauth442",
    name: "HTTP Authorization",
    email: "httpauth442@example.com",
  });
  const note = await insertNotePost(tx, { account: author.account });
  const question = await insertNotePost(tx, { account: author.account });
  await tx
    .update(postTable)
    .set({ type: "Question" })
    .where(eq(postTable.id, question.post.id));
  await tx.insert(pollTable).values({
    postId: question.post.id,
    multiple: false,
    ends: new Date("2099-01-01T00:00:00Z"),
  });
  await tx.insert(pollOptionTable).values([
    { postId: question.post.id, index: 0, title: "One" },
    { postId: question.post.id, index: 1, title: "Two" },
  ]);
  const authorizationId = generateUuidV7();
  await tx.insert(quoteAuthorizationTable).values({
    id: authorizationId,
    iri: `http://localhost/ap/quote-authorizations/${authorizationId}`,
    quotePostIri: "https://remote.example/quote",
    quotedPostId: note.post.id,
    attributedActorId: author.actor.id,
  });
  return {
    author,
    note,
    question,
    authorizationId,
    paths: [
      `/ap/notes/${note.noteSourceId}`,
      `/ap/questions/${question.noteSourceId}`,
      `/ap/creates/${note.post.id}`,
      `/ap/quote-authorizations/${authorizationId}`,
    ],
  };
}

test("object HTTP authorization preserves the signed visibility matrix", async () => {
  await withRollback(async (tx) => {
    const target = await targets(tx);
    const viewers = new Map<string, string | undefined>([
      ["anonymous", undefined],
    ]);
    for (const username of [
      "accepted",
      "pending",
      "mentioned",
      "unrelated",
      "blockee",
      "blocker",
    ]) {
      const actor = await insertRemoteActor(tx, {
        username,
        name: username,
        host: "remote.example",
      });
      viewers.set(username, actor.iri);
      if (username === "accepted" || username === "pending") {
        await tx.insert(followingTable).values({
          iri: `${actor.iri}#follow`,
          followerId: actor.id,
          followeeId: target.author.actor.id,
          accepted: username === "accepted" ? new Date() : null,
        });
      }
      if (username === "mentioned") {
        await tx.insert(mentionTable).values(
          [target.note.post.id, target.question.post.id].map((postId) => ({
            postId,
            actorId: actor.id,
          })),
        );
      }
      if (username === "blockee" || username === "blocker") {
        await tx.insert(blockingTable).values({
          id: generateUuidV7(),
          iri: `${actor.iri}#block`,
          blockerId: username === "blockee" ? target.author.actor.id : actor.id,
          blockeeId: username === "blockee" ? actor.id : target.author.actor.id,
        });
      }
    }
    viewers.set("author", target.author.actor.iri);
    viewers.set("unknown", "https://unknown.example/actor");
    const http = await httpFixture(tx);
    for (const visibility of [
      "public",
      "unlisted",
      "followers",
      "direct",
      "none",
    ] as const) {
      await tx
        .update(postTable)
        .set({ visibility })
        .where(
          inArray(postTable.id, [target.note.post.id, target.question.post.id]),
        );
      await tx
        .update(noteSourceTable)
        .set({ visibility })
        .where(
          inArray(noteSourceTable.id, [
            target.note.noteSourceId,
            target.question.noteSourceId,
          ]),
        );
      for (const [viewer, iri] of viewers) {
        const allowed =
          viewer === "author" ||
          (viewer !== "blockee" &&
            viewer !== "blocker" &&
            (visibility === "public" ||
              visibility === "unlisted" ||
              (visibility === "followers" &&
                (viewer === "accepted" || viewer === "mentioned")) ||
              (visibility === "direct" && viewer === "mentioned")));
        for (const path of target.paths) {
          const response = await http.fetch(path, iri);
          assert.equal(
            response.status,
            allowed ? 200 : 401,
            `${visibility}, ${viewer}, ${path}`,
          );
        }
      }
      // Baseline: a failed signature is treated as anonymous, including on public posts.
      for (const path of target.paths) {
        const response = await http.fetch(path, viewers.get("accepted"), true);
        assert.equal(
          response.status,
          visibility === "public" || visibility === "unlisted" ? 200 : 401,
          `invalid signature: ${visibility}, ${path}`,
        );
      }
    }
    for (const path of [
      "/ap/notes/invalid",
      `/ap/notes/${generateUuidV7()}`,
      `/ap/questions/${target.note.noteSourceId}`,
      `/ap/notes/${target.question.noteSourceId}`,
      `/ap/creates/${target.note.noteSourceId}`,
    ]) {
      assert.equal((await http.fetch(path)).status, 404, path);
    }
  });
});

test("object HTTP dispatch keeps censorship, sanctions and authorization revocation", async () => {
  await withRollback(async (tx) => {
    const target = await targets(tx);
    const http = await httpFixture(tx);
    const censorship = new Date();
    await tx
      .update(postTable)
      .set({ censored: censorship })
      .where(
        inArray(postTable.id, [target.note.post.id, target.question.post.id]),
      );
    for (const path of target.paths) {
      for (const iri of [undefined, target.author.actor.iri]) {
        assert.equal(
          (await http.fetch(path, iri)).status,
          404,
          `censorship: ${path}`,
        );
      }
    }
    await tx
      .update(postTable)
      .set({ censored: null })
      .where(
        inArray(postTable.id, [target.note.post.id, target.question.post.id]),
      );
    await tx
      .update(quoteAuthorizationTable)
      .set({ revoked: true })
      .where(eq(quoteAuthorizationTable.id, target.authorizationId));
    assert.equal(
      (await http.fetch(target.paths[3], target.author.actor.iri)).status,
      404,
    );
    await tx
      .update(quoteAuthorizationTable)
      .set({ revoked: false })
      .where(eq(quoteAuthorizationTable.id, target.authorizationId));
    assert.equal((await http.fetch(target.paths[3])).status, 200);
    await tx
      .update(actorTable)
      .set({ suspended: new Date("2020-01-01"), suspendedUntil: null })
      .where(eq(actorTable.id, target.author.actor.id));
    for (const path of target.paths) {
      assert.equal((await http.fetch(path)).status, 401, `sanction: ${path}`);
      assert.equal(
        (await http.fetch(path, target.author.actor.iri)).status,
        200,
        `author sanction exception: ${path}`,
      );
    }
  });
});

test("reaction HTTP access retains signer, remote-author and article behavior", async () => {
  await withRollback(async (tx) => {
    const target = await targets(tx);
    const viewer = await insertRemoteActor(tx, {
      username: "reactviewer",
      name: "Reaction Viewer",
      host: "remote.example",
    });
    const emojiId = generateUuidV7();
    await tx.insert(customEmojiTable).values({
      id: emojiId,
      iri: "https://remote.example/emoji/test",
      name: ":test:",
      imageUrl: "https://remote.example/test.png",
    });
    const reactionId = generateUuidV7();
    const reactionPath = `/ap/emojireacts/custom/${reactionId}`;
    await tx.insert(reactionTable).values({
      iri: `http://localhost${reactionPath}`,
      postId: target.note.post.id,
      actorId: viewer.id,
      customEmojiId: emojiId,
    });
    const collectionPaths = [
      `/ap/emoji-reactions/notes/${target.note.noteSourceId}`,
      `/ap/emoji-reactions/notes/${target.note.noteSourceId}/page/_`,
      `/ap/emoji-reactions/questions/${target.question.noteSourceId}`,
    ];
    const http = await httpFixture(tx);
    for (const path of [reactionPath, ...collectionPaths]) {
      assert.equal((await http.fetch(path)).status, 200, path);
      assert.equal((await http.fetch(path, viewer.iri)).status, 200, path);
    }
    await tx.insert(blockingTable).values({
      id: generateUuidV7(),
      iri: "https://remote.example/blocks/reaction",
      blockerId: target.author.actor.id,
      blockeeId: viewer.id,
    });
    for (const path of [reactionPath, ...collectionPaths]) {
      assert.equal(
        (await http.fetch(path, viewer.iri)).status,
        404,
        `blocked: ${path}`,
      );
      assert.equal((await http.fetch(path)).status, 200, `anonymous: ${path}`);
    }
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(
        inArray(postTable.id, [target.note.post.id, target.question.post.id]),
      );
    for (const path of [reactionPath, ...collectionPaths]) {
      assert.equal((await http.fetch(path)).status, 404, `censored: ${path}`);
    }
    await tx
      .update(postTable)
      .set({ censored: null, actorId: viewer.id })
      .where(eq(postTable.id, target.note.post.id));
    assert.equal(
      (await http.fetch(reactionPath)).status,
      200,
      "unsigned remote author",
    );
    assert.equal(
      (await http.fetch(reactionPath, viewer.iri)).status,
      404,
      "signed remote author",
    );
    const shared = await insertRemotePost(tx, { actorId: viewer.id });
    await tx
      .update(postTable)
      .set({ sharedPostId: shared.id })
      .where(eq(postTable.id, target.note.post.id));
    assert.equal(
      (await http.fetch(reactionPath)).status,
      404,
      "share wrapper stays fail-closed",
    );
    await tx
      .update(postTable)
      .set({ sharedPostId: null, noteSourceId: null, type: "Article" })
      .where(eq(postTable.id, target.note.post.id));
    assert.equal(
      (await http.fetch(reactionPath, viewer.iri)).status,
      200,
      "article stays publicly fetchable",
    );
  });
});

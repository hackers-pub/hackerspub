import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "@fedify/fedify";
import { Person } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Database, Transaction } from "@hackerspub/models/db";
import { isPostVisibleTo } from "@hackerspub/models/post/visibility";
import {
  actorTable,
  blockingTable,
  followingTable,
  mentionTable,
  postTable,
  type Actor,
  type PostVisibility,
} from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";
import {
  authorizePostFetch,
  isPostVisibleToRequester,
} from "./post-authorization.ts";

async function loadedPost(tx: Transaction, id: Uuid) {
  const post = await tx.query.postTable.findFirst({
    where: { id },
    with: { actor: true },
  });
  assert.ok(post != null);
  return post;
}

// This is the old authorization input, retained as an independent parity
// oracle.  The optimized helper must not execute this fanout query itself.
async function fullVisibilityPost(tx: Transaction, id: Uuid) {
  const post = await tx.query.postTable.findFirst({
    where: { id },
    with: {
      actor: {
        with: {
          followers: { with: { follower: true } },
          blockees: { with: { blockee: true } },
          blockers: { with: { blocker: true } },
        },
      },
      mentions: { with: { actor: true } },
    },
  });
  assert.ok(post != null);
  return post;
}

async function follow(
  tx: Transaction,
  follower: Actor,
  followee: Actor,
  accepted: Date | null = new Date("2026-01-01T00:00:00Z"),
) {
  await tx.insert(followingTable).values({
    iri: `https://follows.example/${generateUuidV7()}`,
    followerId: follower.id,
    followeeId: followee.id,
    accepted,
  });
}

async function block(tx: Transaction, blocker: Actor, blockee: Actor) {
  await tx.insert(blockingTable).values({
    id: generateUuidV7(),
    iri: `https://blocks.example/${generateUuidV7()}`,
    blockerId: blocker.id,
    blockeeId: blockee.id,
  });
}

function observedDatabase(
  db: Database,
  options: { absent?: boolean; events?: string[] } = {},
) {
  const calls: { input: unknown; result: unknown }[] = [];
  const actorQuery = new Proxy(db.query.actorTable, {
    get(target, property) {
      if (property === "findFirst") {
        return async (input: unknown) => {
          options.events?.push("requester query");
          const result = options.absent
            ? undefined
            : await Reflect.apply(target.findFirst, target, [input]);
          calls.push({ input, result });
          return result;
        };
      }
      throw new Error(`Unexpected requester query method: ${String(property)}`);
    },
  });
  const queries = new Proxy(db.query, {
    get(_target, property) {
      assert.equal(
        property,
        "actorTable",
        "authorization must not reload posts",
      );
      return actorQuery;
    },
  });
  return {
    calls,
    db: new Proxy(db, {
      get(target, property, receiver) {
        return property === "query"
          ? queries
          : Reflect.get(target, property, receiver);
      },
    }),
  };
}

test("requester visibility preserves the full-relation visibility matrix", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "authorizationauthor",
      name: "Author",
      email: "authorizationauthor@example.com",
    });
    const viewers = new Map<string, Actor>();
    for (const name of [
      "unrelated",
      "accepted",
      "pending",
      "mentioned",
      "pendingmentioned",
      "blocked",
      "blocker",
    ]) {
      viewers.set(
        name,
        await insertRemoteActor(tx, {
          username: name,
          name,
          host: "authorization.example",
        }),
      );
    }
    const viewer = (name: string) => {
      const actor = viewers.get(name);
      assert.ok(actor != null);
      return actor;
    };
    for (const name of ["accepted", "blocked", "blocker"]) {
      await follow(tx, viewer(name), author.actor);
    }
    for (const name of ["pending", "pendingmentioned"]) {
      await follow(tx, viewer(name), author.actor, null);
    }
    await block(tx, author.actor, viewer("blocked"));
    await block(tx, viewer("blocker"), author.actor);
    const expected: Record<PostVisibility, readonly string[]> = {
      public: [
        "anonymous",
        "unknown",
        "author",
        "unrelated",
        "accepted",
        "pending",
        "mentioned",
        "pendingmentioned",
      ],
      unlisted: [
        "anonymous",
        "unknown",
        "author",
        "unrelated",
        "accepted",
        "pending",
        "mentioned",
        "pendingmentioned",
      ],
      followers: ["author", "accepted", "mentioned", "pendingmentioned"],
      direct: ["author", "mentioned", "pendingmentioned"],
      none: ["author"],
    };
    for (const visibility of Object.keys(expected) as PostVisibility[]) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        visibility,
      });
      await tx
        .insert(mentionTable)
        .values(
          ["mentioned", "pendingmentioned", "blocked", "blocker"].map(
            (name) => ({ postId: post.id, actorId: viewer(name).id }),
          ),
        );
      const full = await fullVisibilityPost(tx, post.id);
      const loaded = await loadedPost(tx, post.id);
      const requesters: [string, string | undefined][] = [
        ["anonymous", undefined],
        ["unknown", "https://unknown.example/actor"],
        ["author", author.actor.iri],
        ...Array.from(viewers, ([name, actor]): [string, string] => [
          name,
          actor.iri,
        ]),
      ];
      for (const [name, iri] of requesters) {
        const label = `${visibility}: ${name}`;
        const baseline = isPostVisibleTo(
          full,
          iri == null ? undefined : { iri },
        );
        assert.equal(baseline, expected[visibility].includes(name), label);
        assert.equal(
          await isPostVisibleToRequester(tx, loaded, iri),
          baseline,
          label,
        );
      }
    }
  });
});

test("follow and mention relationships to other targets never grant access", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "decoyauthor",
      name: "Author",
      email: "decoyauthor@example.com",
    });
    const other = await insertRemoteActor(tx, {
      username: "otherauthor",
      name: "Other author",
      host: "decoys.example",
    });
    const viewer = await insertRemoteActor(tx, {
      username: "viewer",
      name: "Viewer",
      host: "decoys.example",
    });
    await follow(tx, viewer, other);
    // The reverse follow cannot grant the follower-only author's content.
    await follow(tx, author.actor, viewer);
    const { post: mentionedElsewhere } = await insertNotePost(tx, {
      account: author.account,
    });
    await tx.insert(mentionTable).values({
      postId: mentionedElsewhere.id,
      actorId: viewer.id,
    });
    for (const visibility of ["followers", "direct", "none"] as const) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        visibility,
      });
      assert.equal(
        await isPostVisibleToRequester(
          tx,
          await loadedPost(tx, post.id),
          viewer.iri,
        ),
        false,
        visibility,
      );
    }
  });
});

test("author sanctions retain the author fast path and existing expiry rules", async () => {
  await withRollback(async (tx) => {
    const local = await insertAccountWithActor(tx, {
      username: "sanctionauthor",
      name: "Author",
      email: "sanctionauthor@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "sanctionauthor",
      name: "Remote author",
      host: "sanctions.example",
    });
    const requester = await insertRemoteActor(tx, {
      username: "requester",
      name: "Requester",
      host: "sanctions.example",
    });
    const before = new Date(Date.now() - 120_000);
    const expired = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 120_000);
    const cases = [
      {
        name: "permanent local",
        actor: local.actor,
        until: null,
        hidden: true,
      },
      {
        name: "temporary local",
        actor: local.actor,
        until: future,
        hidden: false,
      },
      {
        name: "expired local",
        actor: local.actor,
        until: expired,
        hidden: false,
      },
      { name: "permanent remote", actor: remote, until: null, hidden: true },
      { name: "temporary remote", actor: remote, until: future, hidden: true },
      { name: "expired remote", actor: remote, until: expired, hidden: false },
    ];
    for (const scenario of cases) {
      await tx
        .update(actorTable)
        .set({ suspended: before, suspendedUntil: scenario.until })
        .where(eq(actorTable.id, scenario.actor.id));
      const post = await insertRemotePost(tx, { actorId: scenario.actor.id });
      const loaded = await loadedPost(tx, post.id);
      const full = await fullVisibilityPost(tx, post.id);
      for (const iri of [undefined, requester.iri, scenario.actor.iri]) {
        const expected = iri === scenario.actor.iri || !scenario.hidden;
        assert.equal(
          isPostVisibleTo(full, iri == null ? undefined : { iri }),
          expected,
          scenario.name,
        );
        assert.equal(
          await isPostVisibleToRequester(tx, loaded, iri),
          expected,
          scenario.name,
        );
      }
    }
    await tx
      .update(actorTable)
      .set({ suspended: before, suspendedUntil: null })
      .where(eq(actorTable.id, requester.id));
    await tx
      .update(actorTable)
      .set({ suspended: null, suspendedUntil: null })
      .where(eq(actorTable.id, local.actor.id));
    const post = await insertRemotePost(tx, { actorId: local.actor.id });
    assert.equal(
      await isPostVisibleToRequester(
        tx,
        await loadedPost(tx, post.id),
        requester.iri,
      ),
      true,
      "a sanctioned requester can still read another author's public post",
    );
  });
});

test("visibility keeps censored permalink semantics and fails closed on share wrappers", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "wrapperauthor",
      name: "Author",
      email: "wrapperauthor@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.id));
    assert.equal(
      await isPostVisibleToRequester(tx, await loadedPost(tx, post.id)),
      true,
      "censorship is enforced by callers, not the shared visibility predicate",
    );
    const { post: wrapper } = await insertNotePost(tx, {
      account: author.account,
      sharedPostId: post.id,
    });
    const loaded = await loadedPost(tx, wrapper.id);
    for (const iri of [undefined, author.actor.iri]) {
      assert.equal(await isPostVisibleToRequester(tx, loaded, iri), false);
    }
  });
});

test("anonymous skips requester queries and an absent lookup preserves the verified author IRI", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "unknownauthor",
      name: "Author",
      email: "unknownauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      visibility: "none",
    });
    const loaded = await loadedPost(tx, post.id);
    const observed = observedDatabase(tx);
    assert.equal(await isPostVisibleToRequester(observed.db, loaded), false);
    assert.equal(observed.calls.length, 0);
    assert.equal(
      await isPostVisibleToRequester(
        observed.db,
        loaded,
        "https://absent.example/actor",
      ),
      false,
    );
    assert.equal(observed.calls.length, 1);
    assert.equal(observed.calls[0].result, undefined);

    // A consistent DB always contains the loaded author.  Simulate the
    // exceptional missing lookup explicitly to exercise the IRI fallback.
    const absent = observedDatabase(tx, { absent: true });
    assert.equal(
      await isPostVisibleToRequester(absent.db, loaded, author.actor.iri),
      true,
    );
    assert.equal(absent.calls.length, 1);
    assert.equal(absent.calls[0].result, undefined);
  });
});

test("requester relation rows stay bounded as author and requester relationships grow", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "fanoutauthor",
      name: "Author",
      email: "fanoutauthor@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "fanoutrequester",
      name: "Requester",
      host: "fanout.example",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
    });
    await follow(tx, requester, author.actor);
    await block(tx, requester, author.actor);
    await block(tx, author.actor, requester);
    await tx.insert(mentionTable).values({
      postId: post.id,
      actorId: requester.id,
    });
    const loaded = await loadedPost(tx, post.id);
    for (const additions of [0, 16, 48]) {
      if (additions > 0) {
        const noise = Array.from({ length: additions }, () => ({
          id: generateUuidV7(),
          postId: generateUuidV7(),
        }));
        await tx.insert(actorTable).values(
          noise.map(({ id }) => ({
            id,
            iri: `https://fanout.example/actors/${id}`,
            type: "Person" as const,
            username: `noise-${id}`,
            instanceHost: "fanout.example",
            handleHost: "fanout.example",
            inboxUrl: `https://fanout.example/actors/${id}/inbox`,
          })),
        );
        await tx.insert(postTable).values(
          noise.map(({ postId }) => ({
            id: postId,
            iri: `https://fanout.example/posts/${postId}`,
            type: "Note" as const,
            actorId: author.actor.id,
            visibility: "direct" as const,
            contentHtml: "<p>Other post</p>",
          })),
        );
        await tx.insert(followingTable).values(
          noise.flatMap(({ id }) => [
            {
              iri: `https://fanout.example/follows/${generateUuidV7()}`,
              followerId: id,
              followeeId: author.actor.id,
              accepted: new Date(),
            },
            {
              iri: `https://fanout.example/follows/${generateUuidV7()}`,
              followerId: requester.id,
              followeeId: id,
              accepted: new Date(),
            },
          ]),
        );
        await tx.insert(blockingTable).values(
          noise.flatMap(({ id }) =>
            [
              [author.actor.id, id],
              [id, author.actor.id],
              [requester.id, id],
              [id, requester.id],
            ].map(([blockerId, blockeeId]) => ({
              id: generateUuidV7(),
              iri: `https://fanout.example/blocks/${generateUuidV7()}`,
              blockerId,
              blockeeId,
            })),
          ),
        );
        await tx.insert(mentionTable).values(
          noise.flatMap(({ id, postId }) => [
            { postId: post.id, actorId: id },
            { postId, actorId: requester.id },
          ]),
        );
      }
      const observed = observedDatabase(tx);
      const full = await fullVisibilityPost(tx, post.id);
      const baseline = isPostVisibleTo(full, { iri: requester.iri });
      assert.equal(baseline, false);
      assert.equal(
        await isPostVisibleToRequester(observed.db, loaded, requester.iri),
        baseline,
      );
      assert.equal(observed.calls.length, 1);
      const row = observed.calls[0].result;
      assert.ok(row != null && typeof row === "object");
      for (const relation of [
        "followees",
        "blockees",
        "blockers",
        "mentions",
      ]) {
        assert.ok(relation in row);
        const rows: unknown = Reflect.get(row, relation);
        assert.ok(Array.isArray(rows));
        assert.equal(rows.length, 1, relation);
        for (const relationRow of rows) {
          assert.ok(
            Object.values(relationRow).every(
              (value) =>
                value == null ||
                typeof value !== "object" ||
                value instanceof Date,
            ),
            `${relation} must contain no nested actor records`,
          );
        }
      }
      assert.equal(full.actor.followers.length, full.mentions.length);
      assert.ok(full.actor.followers.length >= additions + 1);
    }
  });
});

test("post fetch verifies with the supplied authenticated loader before querying the requester", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "loaderauthor",
      name: "Author",
      email: "loaderauthor@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "loaderrequester",
      name: "Requester",
      host: "loader.example",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const loaded = await loadedPost(tx, post.id);
    const events: string[] = [];
    const observed = observedDatabase(tx, { events });
    const loader = async () => {
      throw new Error("the controlled verifier does not fetch documents");
    };
    let owner: Person | null = new Person({ id: new URL(requester.iri) });
    let failure: Error | undefined;
    const identifier = generateUuidV7();
    const ctx = {
      data: { db: observed.db },
      async getDocumentLoader(options: { identifier: string }) {
        events.push("document loader");
        assert.deepEqual(options, { identifier });
        return loader;
      },
      async getSignedKeyOwner(options: { documentLoader: unknown }) {
        events.push("verified owner");
        assert.equal(options.documentLoader, loader);
        if (failure != null) throw failure;
        return owner;
      },
    } as unknown as RequestContext<ContextData>;
    assert.equal(await authorizePostFetch(ctx, loaded, identifier), true);
    assert.deepEqual(events, [
      "document loader",
      "verified owner",
      "requester query",
    ]);
    assert.equal(observed.calls.length, 1);
    for (const absentOwner of [null, new Person({})]) {
      owner = absentOwner;
      events.length = 0;
      observed.calls.length = 0;
      assert.equal(await authorizePostFetch(ctx, loaded, identifier), true);
      assert.deepEqual(events, ["document loader", "verified owner"]);
      assert.equal(observed.calls.length, 0);
      assert.equal(
        await authorizePostFetch(
          ctx,
          { ...loaded, visibility: "followers" },
          identifier,
        ),
        false,
      );
    }
    failure = new Error("signature verification failed");
    events.length = 0;
    observed.calls.length = 0;
    await assert.rejects(authorizePostFetch(ctx, loaded, identifier), failure);
    assert.deepEqual(events, ["document loader", "verified owner"]);
    assert.equal(observed.calls.length, 0);
  });
});

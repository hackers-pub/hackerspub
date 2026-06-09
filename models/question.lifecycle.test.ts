import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { Create, Person, Question as ActivityPubQuestion } from "@fedify/vocab";
import type { ContextData } from "./context.ts";
import type { Transaction } from "./db.ts";
import { createQuestion } from "./question.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("createQuestion() creates a source-backed Question with a poll", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createquestionauthor",
      name: "Create Question Author",
      email: "createquestionauthor@example.com",
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as Context<ContextData<Transaction>>;
    const published = new Date("2026-04-15T00:00:00.000Z");

    const question = await createQuestion(fedCtx, {
      accountId: author.account.id,
      visibility: "public",
      quotePolicy: "everyone",
      content: "Which runtime should we use?",
      language: "en",
      media: [],
      published,
      updated: published,
      poll: {
        title: "Runtime choice",
        multiple: false,
        options: ["Deno", "Node.js"],
        ends: new Date("2026-04-16T00:00:00.000Z"),
        now: published,
      },
    });

    assert.ok(question != null);
    assert.equal(question.type, "Question");
    assert.equal(question.name, "Runtime choice");
    assert.equal(question.noteSourceId, question.noteSource.id);
    assert.equal(
      question.iri,
      `http://localhost/objects/${question.noteSource.id}`,
    );
    assert.equal(
      question.url,
      `http://localhost/@${author.account.username}/${question.noteSource.id}`,
    );
    assert.match(question.contentHtml, /Which runtime/);

    const poll = await tx.query.pollTable.findFirst({
      where: { postId: question.id },
      with: { options: true },
    });
    assert.ok(poll != null);
    assert.equal(poll.multiple, false);
    assert.equal(poll.ends.toISOString(), "2026-04-16T00:00:00.000Z");
    assert.deepEqual(
      poll.options.toSorted((a, b) => a.index - b.index).map((option) =>
        option.title
      ),
      ["Deno", "Node.js"],
    );

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: author.account.id,
        postId: question.id,
      },
    });
    assert.ok(timelineItem != null);

    const create = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Create);
    assert.ok(create instanceof Create);
    const object = await create.getObject({ ...fedCtx, suppressError: true });
    assert.ok(object instanceof ActivityPubQuestion);
    assert.equal(object.name?.toString(), "Runtime choice");
    assert.equal(
      object.endTime?.toString(),
      "2026-04-16T00:00:00Z",
    );
    const options = await Array.fromAsync(object.getExclusiveOptions());
    assert.deepEqual(options.map((option) => option.name?.toString()), [
      "Deno",
      "Node.js",
    ]);
  });
});

test("createQuestion() does not federate none visibility polls to followers", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "nonequestionauthor",
      name: "None Question Author",
      email: "nonequestionauthor@example.com",
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as Context<ContextData<Transaction>>;
    const now = new Date("2026-04-15T00:00:00.000Z");

    const question = await createQuestion(fedCtx, {
      accountId: author.account.id,
      visibility: "none",
      quotePolicy: "self",
      content: "Local-only poll",
      language: "en",
      media: [],
      published: now,
      updated: now,
      poll: {
        title: "Private choice",
        multiple: false,
        options: ["Yes", "No"],
        ends: new Date("2026-04-16T00:00:00.000Z"),
        now,
      },
    });

    assert.ok(question != null);
    assert.equal(
      sent.some((args) => args[1] === "followers"),
      false,
    );
  });
});

test("createQuestion() throws when a requested medium cannot be attached", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "missingquestionmedia",
      name: "Missing Question Media",
      email: "missingquestionmedia@example.com",
    });
    const fedCtx = createFedCtx(tx) as unknown as Context<
      ContextData<Transaction>
    >;
    const now = new Date("2026-04-15T00:00:00.000Z");

    await assert.rejects(
      () =>
        createQuestion(fedCtx, {
          accountId: author.account.id,
          visibility: "public",
          content: "Missing image",
          language: "en",
          media: [
            { mediumId: generateUuidV7(), alt: "Missing medium" },
          ],
          poll: {
            title: "Pick one",
            multiple: false,
            options: ["Yes", "No"],
            ends: new Date("2026-04-16T00:00:00.000Z"),
            now,
          },
        }),
      { message: "Failed to create note source medium." },
    );
  });
});

test("createQuestion() creates reply notifications without duplicate mention notifications", async () => {
  await withRollback(async (tx) => {
    const targetAuthor = await insertAccountWithActor(tx, {
      username: "questionreplytarget",
      name: "Question Reply Target",
      email: "questionreplytarget@example.com",
    });
    const author = await insertAccountWithActor(tx, {
      username: "questionreplyauthor",
      name: "Question Reply Author",
      email: "questionreplyauthor@example.com",
    });
    const { post: replyTarget } = await insertNotePost(tx, {
      account: targetAuthor.account,
      content: "Original note",
    });
    const fedCtx = createFedCtx(tx) as unknown as Context<
      ContextData<Transaction>
    >;
    fedCtx.lookupObject = (handle: string) => {
      if (handle !== "@questionreplytarget@localhost") {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        new Person({
          id: new URL(targetAuthor.actor.iri),
          preferredUsername: targetAuthor.actor.username,
          name: targetAuthor.actor.name,
          inbox: new URL(targetAuthor.actor.inboxUrl),
        }),
      );
    };
    const now = new Date("2026-04-15T00:00:00.000Z");

    const question = await createQuestion(fedCtx, {
      accountId: author.account.id,
      visibility: "public",
      content: "Replying to @questionreplytarget@localhost",
      language: "en",
      media: [],
      published: now,
      updated: now,
      poll: {
        title: "Reply poll",
        multiple: false,
        options: ["Yes", "No"],
        ends: new Date("2026-04-16T00:00:00.000Z"),
        now,
      },
    }, { replyTarget: { ...replyTarget, actor: targetAuthor.actor } });

    assert.ok(question != null);
    assert.equal(
      question.mentions.some((mention) =>
        mention.actorId === targetAuthor.actor.id
      ),
      true,
    );
    const notifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: targetAuthor.account.id,
        postId: question.id,
      },
    });
    assert.deepEqual(
      notifications.map((notification) => notification.type).toSorted(),
      ["reply"],
    );
  });
});

test("createQuestion() rolls back the poll when source-backed Question creation fails", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "invalidquestionauthor",
      name: "Invalid Question Author",
      email: "invalidquestionauthor@example.com",
    });
    const fedCtx = createFedCtx(tx) as unknown as Context<
      ContextData<Transaction>
    >;
    const now = new Date("2026-04-15T00:00:00.000Z");

    await assert.rejects(
      () =>
        createQuestion(fedCtx, {
          accountId: author.account.id,
          visibility: "public",
          content: "Duplicate options",
          language: "en",
          media: [],
          poll: {
            title: "Pick one",
            multiple: false,
            options: ["Deno", "Deno"],
            ends: new Date("2026-04-16T00:00:00.000Z"),
            now,
          },
        }),
      { name: "InvalidPollInputError" },
    );

    const source = await tx.query.noteSourceTable.findFirst({
      where: {
        accountId: author.account.id,
        content: "Duplicate options",
      },
    });
    assert.equal(source, undefined);
  });
});

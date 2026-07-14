import assert from "node:assert";
import test from "node:test";
import { Environment, Network, RecordSource, Store } from "relay-runtime";
import { updateCreatedPostConnections } from "./relayUpdates.ts";

function environment(): Environment {
  return new Environment({
    network: Network.create(() => Promise.resolve({ data: {} })),
    store: new Store(new RecordSource()),
  });
}

test("updateCreatedPostConnections appends and increments only successful payloads", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const payload = store.create("payload", "CreateNotePayload");
    const post = store.create("post", "Note");
    payload.setLinkedRecord(post, "note");
    store.getRoot().setLinkedRecord(payload, "createNote");

    const connection = store.create("connection", "PostConnection");
    connection.setLinkedRecords([], "edges");
    const target = store.create("target", "Note");
    const replies = store.create("replies", "PostConnection");
    replies.setValue(4, "totalCount");
    target.setLinkedRecord(replies, "replies", {
      first: 0,
      actingAccountId: null,
    });

    assert.equal(
      updateCreatedPostConnections(store, {
        rootFieldName: "createNote",
        postFieldName: "note",
        appendConnectionIds: ["connection"],
        replyTargetId: "target",
        actingAccountId: null,
      }),
      true,
    );
    assert.equal(connection.getLinkedRecords("edges")?.length, 1);
    assert.equal(replies.getValue("totalCount"), 5);
  });
});

test("updateCreatedPostConnections leaves counters unchanged for error payloads", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const payload = store.create("payload", "InvalidInputError");
    store.getRoot().setLinkedRecord(payload, "createNote");
    const target = store.create("target", "Note");
    const replies = store.create("replies", "PostConnection");
    replies.setValue(4, "totalCount");
    target.setLinkedRecord(replies, "replies", {
      first: 0,
      actingAccountId: null,
    });

    assert.equal(
      updateCreatedPostConnections(store, {
        rootFieldName: "createNote",
        postFieldName: "note",
        appendConnectionIds: [],
        replyTargetId: "target",
        actingAccountId: null,
      }),
      false,
    );
    assert.equal(replies.getValue("totalCount"), 4);
  });
});

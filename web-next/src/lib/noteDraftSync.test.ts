import assert from "node:assert";
import test from "node:test";
import {
  flushNoteDraftScope,
  publishNoteDraftChange,
  registerNoteDraftFlush,
  subscribeNoteDraftChanges,
} from "./noteDraftSync.ts";

test("flushNoteDraftScope flushes matching scopes only", () => {
  let newFlushes = 0;
  let replyFlushes = 0;
  const unregisterNew = registerNoteDraftFlush({ type: "new" }, () => {
    newFlushes++;
    return true;
  });
  const unregisterReply = registerNoteDraftFlush(
    { type: "reply", targetId: "note-1" },
    () => {
      replyFlushes++;
      return true;
    },
  );

  assert.equal(flushNoteDraftScope({ type: "new" }), true);
  assert.equal(newFlushes, 1);
  assert.equal(replyFlushes, 0);

  assert.equal(
    flushNoteDraftScope({ type: "reply", targetId: "note-2" }),
    true,
  );
  assert.equal(replyFlushes, 0);

  unregisterNew();
  unregisterReply();
});

test("flushNoteDraftScope reports failed matching flushes", () => {
  const unregisterOk = registerNoteDraftFlush({ type: "new" }, () => true);
  const unregisterFailed = registerNoteDraftFlush({ type: "new" }, () => false);

  assert.equal(flushNoteDraftScope({ type: "new" }), false);

  unregisterOk();
  unregisterFailed();
});

test("subscribeNoteDraftChanges receives published changes", () => {
  const origin = Symbol("origin");
  const received: string[] = [];
  const unsubscribe = subscribeNoteDraftChanges((change) => {
    if (change.origin === origin) {
      received.push(change.key);
    }
  });

  publishNoteDraftChange({ key: "draft-key", origin });
  unsubscribe();
  publishNoteDraftChange({ key: "ignored", origin });

  assert.deepEqual(received, ["draft-key"]);
});

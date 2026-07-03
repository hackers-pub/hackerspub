import assert from "node:assert";
import test from "node:test";
import {
  getNoteDraftStorageKey,
  type NoteDraftData,
  type NoteDraftScope,
  type NoteDraftStorage,
  parseNoteDraft,
  readNoteDraft,
  removeNoteDraft,
  serializeNoteDraft,
  writeNoteDraft,
} from "./noteDraftStorage.ts";

class MemoryStorage implements NoteDraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function draft(overrides: Partial<NoteDraftData> = {}): NoteDraftData {
  return {
    content: "hello",
    visibility: "PUBLIC",
    quotePolicy: "EVERYONE",
    actingAccountKey: "personal",
    media: [],
    poll: {
      enabled: false,
      title: "",
      multiple: false,
      ends: "",
      options: [
        { localId: "a", title: "" },
        { localId: "b", title: "" },
      ],
    },
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

test("getNoteDraftStorageKey separates users and scopes", () => {
  assert.notEqual(
    getNoteDraftStorageKey("alice", { type: "new" }),
    getNoteDraftStorageKey("bob", { type: "new" }),
  );
  assert.notEqual(
    getNoteDraftStorageKey("alice", { type: "reply", targetId: "one" }),
    getNoteDraftStorageKey("alice", { type: "reply", targetId: "two" }),
  );
});

test("parseNoteDraft ignores invalid and empty payloads", () => {
  assert.equal(parseNoteDraft("not json"), null);
  assert.equal(parseNoteDraft(JSON.stringify({ version: 99 })), null);
  assert.equal(
    parseNoteDraft(
      serializeNoteDraft({ type: "new" }, draft({ content: " " }))!,
    ),
    null,
  );
});

test("writeNoteDraft removes empty drafts instead of storing them", () => {
  const storage = new MemoryStorage();
  const key = getNoteDraftStorageKey("alice", { type: "new" });
  assert.equal(writeNoteDraft(storage, key, { type: "new" }, draft()), "ok");
  assert.equal(storage.values.has(key), true);

  assert.equal(
    writeNoteDraft(storage, key, { type: "new" }, draft({ content: "" })),
    "empty",
  );
  assert.equal(storage.values.has(key), false);
});

test("round-trips uploaded media references", () => {
  const storage = new MemoryStorage();
  const scope: NoteDraftScope = { type: "quote", targetId: "note-id" };
  const key = getNoteDraftStorageKey("alice", scope);
  const value = draft({
    media: [
      {
        localId: "local",
        mediumRelayId: "relay-medium",
        uuid: "00000000-0000-0000-0000-000000000000",
        url: "https://example.com/media.webp",
        alt: "diagram",
        width: 100,
        height: 50,
      },
    ],
  });

  assert.equal(writeNoteDraft(storage, key, scope, value), "ok");
  assert.deepEqual(readNoteDraft(storage, key)?.media, value.media);
});

test("removeNoteDraft tolerates missing keys", () => {
  const storage = new MemoryStorage();
  assert.equal(removeNoteDraft(storage, "missing"), "ok");
});

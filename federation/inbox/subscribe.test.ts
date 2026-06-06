import assert from "node:assert";
import test from "node:test";
import type { InboxContext } from "@fedify/fedify";
import type { Add, Remove } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { onPostPinned, onPostUnpinned } from "./subscribe.ts";

test("onPostPinned ignores tags.pub hashtag actors without fetching them", async () => {
  let actorFetches = 0;
  const add = {
    actorId: new URL("https://tags.pub/user/rust"),
    targetId: new URL("https://tags.pub/user/rust/collections/featured"),
    objectId: new URL("https://example.com/posts/1"),
    getActor() {
      actorFetches++;
      throw new Error("unexpected actor fetch");
    },
  } as unknown as Add;

  await onPostPinned({} as InboxContext<ContextData>, add);

  assert.equal(actorFetches, 0);
});

test("onPostUnpinned ignores tags.pub hashtag actors without fetching them", async () => {
  let actorFetches = 0;
  const remove = {
    actorId: new URL("https://tags.pub/user/rust"),
    targetId: new URL("https://tags.pub/user/rust/collections/featured"),
    objectId: new URL("https://example.com/posts/1"),
    getActor() {
      actorFetches++;
      throw new Error("unexpected actor fetch");
    },
  } as unknown as Remove;

  await onPostUnpinned({} as InboxContext<ContextData>, remove);

  assert.equal(actorFetches, 0);
});

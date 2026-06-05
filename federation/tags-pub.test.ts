import assert from "node:assert/strict";
import test from "node:test";
import { describe, it } from "node:test";
import * as vocab from "@fedify/vocab";
import {
  DEFAULT_TAGS_PUB_RELAY_ACTOR_ID,
  DEFAULT_TAGS_PUB_RELAY_INBOX_ID,
  getTagsPubRelayConfig,
  getTagsPubRelayDecision,
  getTagsPubRelayRecipient,
  hasTagsPubOptOut,
  shouldSendToTagsPubRelay,
} from "./tags-pub.ts";

describe("getTagsPubRelayConfig()", () => {
  it("is disabled unless explicitly enabled", () => {
    assert.deepEqual(getTagsPubRelayConfig({}), { enabled: false });
  });

  it("uses the documented tags.pub relay endpoint by default", () => {
    assert.deepEqual(getTagsPubRelayConfig({ TAGS_PUB_RELAY: "true" }), {
      enabled: true,
      actorId: DEFAULT_TAGS_PUB_RELAY_ACTOR_ID,
      inboxId: DEFAULT_TAGS_PUB_RELAY_INBOX_ID,
    });
  });

  it("accepts a custom relay inbox URL", () => {
    assert.deepEqual(
      getTagsPubRelayConfig({
        TAGS_PUB_RELAY: "1",
        TAGS_PUB_RELAY_INBOX_URL: "https://relay.example/inbox",
      }),
      {
        enabled: true,
        actorId: new URL("https://relay.example/"),
        inboxId: new URL("https://relay.example/inbox"),
      },
    );
  });
});

test("getTagsPubRelayRecipient()", () => {
  assert.deepEqual(
    getTagsPubRelayRecipient({
      enabled: true,
      actorId: DEFAULT_TAGS_PUB_RELAY_ACTOR_ID,
      inboxId: DEFAULT_TAGS_PUB_RELAY_INBOX_ID,
    }),
    {
      id: DEFAULT_TAGS_PUB_RELAY_ACTOR_ID,
      inboxId: DEFAULT_TAGS_PUB_RELAY_INBOX_ID,
      endpoints: null,
    },
  );
});

test("hasTagsPubOptOut()", () => {
  assert.deepEqual(hasTagsPubOptOut("Please respect #NoTagsPub"), true);
  assert.deepEqual(hasTagsPubOptOut("I use #NoBots in my profile"), true);
  assert.deepEqual(hasTagsPubOptOut("I use #NoBot in my profile"), true);
  assert.deepEqual(hasTagsPubOptOut("Regular profile #ActivityPub"), false);
  assert.deepEqual(hasTagsPubOptOut(null), false);
});

describe("shouldSendToTagsPubRelay()", () => {
  const note = new vocab.Note({
    id: new URL("https://example.com/notes/1"),
    to: vocab.PUBLIC_COLLECTION,
    tags: [
      new vocab.Hashtag({
        name: "#fediverse",
        href: new URL("https://example.com/tags/fediverse"),
      }),
    ],
  });
  const create = new vocab.Create({
    id: new URL("https://example.com/notes/1#create"),
    actor: new URL("https://example.com/users/alice"),
    to: vocab.PUBLIC_COLLECTION,
    object: note,
  });

  it("sends public hashtagged creates", async () => {
    assert.deepEqual(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "",
      }),
      true,
    );
  });

  it(
    "returns the tags that should be persisted as relayed",
    async () => {
      assert.deepEqual(
        await getTagsPubRelayDecision(create, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "",
        }),
        {
          send: true,
          relayedTags: ["fediverse"],
        },
      );
    },
  );

  it("does not send when relay integration is disabled", async () => {
    assert.deepEqual(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: false },
        visibility: "public",
        accountBio: "",
      }),
      false,
    );
  });

  it("does not send non-public posts", async () => {
    assert.deepEqual(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "unlisted",
        accountBio: "",
      }),
      false,
    );
  });

  it(
    "does not clean up non-public posts that were never relayed",
    async () => {
      const update = new vocab.Update({
        id: new URL("https://example.com/notes/1#update-unrelayed"),
        actor: new URL("https://example.com/users/alice"),
        object: note,
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(update, {
          config: { enabled: true },
          visibility: "followers",
          accountBio: "",
          relayedTags: [],
        }),
        false,
      );
    },
  );

  it("allows cleanup updates after visibility changes", async () => {
    const update = new vocab.Update({
      id: new URL("https://example.com/notes/1#update-private"),
      actor: new URL("https://example.com/users/alice"),
      object: new vocab.Note({
        id: new URL("https://example.com/notes/1"),
      }),
    });

    assert.deepEqual(
      await shouldSendToTagsPubRelay(update, {
        config: { enabled: true },
        visibility: "unlisted",
        accountBio: "",
        relayedTags: ["fediverse"],
      }),
      true,
    );
  });

  it("respects account-level opt-out tags", async () => {
    assert.deepEqual(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "Please skip me #NoTagsPub",
      }),
      false,
    );
  });

  it(
    "allows cleanup updates after account-level opt-out",
    async () => {
      const update = new vocab.Update({
        id: new URL("https://example.com/notes/1#update-detag"),
        actor: new URL("https://example.com/users/alice"),
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Note({
          id: new URL("https://example.com/notes/1"),
          to: vocab.PUBLIC_COLLECTION,
        }),
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(update, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "#NoTagsPub",
          relayedTags: ["fediverse"],
        }),
        true,
      );
    },
  );

  it(
    "blocks newly added hashtags after account-level opt-out",
    async () => {
      const update = new vocab.Update({
        id: new URL("https://example.com/notes/1#update-new-tag"),
        actor: new URL("https://example.com/users/alice"),
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Note({
          id: new URL("https://example.com/notes/1"),
          to: vocab.PUBLIC_COLLECTION,
          tags: [
            new vocab.Hashtag({
              name: "#fediverse",
              href: new URL("https://example.com/tags/fediverse"),
            }),
            new vocab.Hashtag({
              name: "#newtag",
              href: new URL("https://example.com/tags/newtag"),
            }),
          ],
        }),
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(update, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "#NoTagsPub",
          relayedTags: ["fediverse"],
        }),
        false,
      );
    },
  );

  it("does not send creates without hashtags", async () => {
    const plainCreate = new vocab.Create({
      id: new URL("https://example.com/notes/2#create"),
      actor: new URL("https://example.com/users/alice"),
      to: vocab.PUBLIC_COLLECTION,
      object: new vocab.Note({
        id: new URL("https://example.com/notes/2"),
        to: vocab.PUBLIC_COLLECTION,
      }),
    });

    assert.deepEqual(
      await shouldSendToTagsPubRelay(plainCreate, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "",
      }),
      false,
    );
  });

  it(
    "sends updates when previous hashtags need reconciliation",
    async () => {
      const update = new vocab.Update({
        id: new URL("https://example.com/notes/3#update"),
        actor: new URL("https://example.com/users/alice"),
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Note({
          id: new URL("https://example.com/notes/3"),
          to: vocab.PUBLIC_COLLECTION,
        }),
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(update, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "",
          relayedTags: ["fediverse"],
        }),
        true,
      );
    },
  );

  it(
    "sends deletes only for previously tagged public posts",
    async () => {
      const activity = new vocab.Delete({
        id: new URL("https://example.com/notes/4#delete"),
        actor: new URL("https://example.com/users/alice"),
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Tombstone({
          id: new URL("https://example.com/notes/4"),
        }),
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(activity, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "",
          relayedTags: ["fediverse"],
        }),
        true,
      );
      assert.deepEqual(
        await shouldSendToTagsPubRelay(activity, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "",
          relayedTags: [],
        }),
        false,
      );
    },
  );

  it(
    "allows cleanup deletes after account-level opt-out",
    async () => {
      const activity = new vocab.Delete({
        id: new URL("https://example.com/notes/5#delete"),
        actor: new URL("https://example.com/users/alice"),
        to: vocab.PUBLIC_COLLECTION,
        object: new vocab.Tombstone({
          id: new URL("https://example.com/notes/5"),
        }),
      });

      assert.deepEqual(
        await shouldSendToTagsPubRelay(activity, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "#NoBots",
          relayedTags: ["fediverse"],
        }),
        true,
      );
    },
  );
});

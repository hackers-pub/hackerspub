import { assertEquals } from "@std/assert/equals";
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

Deno.test("getTagsPubRelayConfig()", async (t) => {
  await t.step("is disabled unless explicitly enabled", () => {
    assertEquals(getTagsPubRelayConfig({}), { enabled: false });
  });

  await t.step("uses the documented tags.pub relay endpoint by default", () => {
    assertEquals(getTagsPubRelayConfig({ TAGS_PUB_RELAY: "true" }), {
      enabled: true,
      actorId: DEFAULT_TAGS_PUB_RELAY_ACTOR_ID,
      inboxId: DEFAULT_TAGS_PUB_RELAY_INBOX_ID,
    });
  });

  await t.step("accepts a custom relay inbox URL", () => {
    assertEquals(
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

Deno.test("getTagsPubRelayRecipient()", () => {
  assertEquals(
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

Deno.test("hasTagsPubOptOut()", () => {
  assertEquals(hasTagsPubOptOut("Please respect #NoTagsPub"), true);
  assertEquals(hasTagsPubOptOut("I use #NoBots in my profile"), true);
  assertEquals(hasTagsPubOptOut("I use #NoBot in my profile"), true);
  assertEquals(hasTagsPubOptOut("Regular profile #ActivityPub"), false);
  assertEquals(hasTagsPubOptOut(null), false);
});

Deno.test("shouldSendToTagsPubRelay()", async (t) => {
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

  await t.step("sends public hashtagged creates", async () => {
    assertEquals(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "",
      }),
      true,
    );
  });

  await t.step(
    "returns the tags that should be persisted as relayed",
    async () => {
      assertEquals(
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

  await t.step("does not send when relay integration is disabled", async () => {
    assertEquals(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: false },
        visibility: "public",
        accountBio: "",
      }),
      false,
    );
  });

  await t.step("does not send non-public posts", async () => {
    assertEquals(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "unlisted",
        accountBio: "",
      }),
      false,
    );
  });

  await t.step(
    "does not clean up non-public posts that were never relayed",
    async () => {
      const update = new vocab.Update({
        id: new URL("https://example.com/notes/1#update-unrelayed"),
        actor: new URL("https://example.com/users/alice"),
        object: note,
      });

      assertEquals(
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

  await t.step("allows cleanup updates after visibility changes", async () => {
    const update = new vocab.Update({
      id: new URL("https://example.com/notes/1#update-private"),
      actor: new URL("https://example.com/users/alice"),
      object: new vocab.Note({
        id: new URL("https://example.com/notes/1"),
      }),
    });

    assertEquals(
      await shouldSendToTagsPubRelay(update, {
        config: { enabled: true },
        visibility: "unlisted",
        accountBio: "",
        relayedTags: ["fediverse"],
      }),
      true,
    );
  });

  await t.step("respects account-level opt-out tags", async () => {
    assertEquals(
      await shouldSendToTagsPubRelay(create, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "Please skip me #NoTagsPub",
      }),
      false,
    );
  });

  await t.step(
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

      assertEquals(
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

  await t.step(
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

      assertEquals(
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

  await t.step("does not send creates without hashtags", async () => {
    const plainCreate = new vocab.Create({
      id: new URL("https://example.com/notes/2#create"),
      actor: new URL("https://example.com/users/alice"),
      to: vocab.PUBLIC_COLLECTION,
      object: new vocab.Note({
        id: new URL("https://example.com/notes/2"),
        to: vocab.PUBLIC_COLLECTION,
      }),
    });

    assertEquals(
      await shouldSendToTagsPubRelay(plainCreate, {
        config: { enabled: true },
        visibility: "public",
        accountBio: "",
      }),
      false,
    );
  });

  await t.step(
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

      assertEquals(
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

  await t.step(
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

      assertEquals(
        await shouldSendToTagsPubRelay(activity, {
          config: { enabled: true },
          visibility: "public",
          accountBio: "",
          relayedTags: ["fediverse"],
        }),
        true,
      );
      assertEquals(
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

  await t.step(
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

      assertEquals(
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

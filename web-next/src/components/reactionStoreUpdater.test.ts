import assert from "node:assert";
import test from "node:test";
import {
  Environment,
  Network,
  RecordSource,
  type RecordSourceProxy,
  Store,
} from "relay-runtime";
import {
  type ReactionTarget,
  updateReactionStore,
} from "./reactionStoreUpdater.ts";

function environment(): Environment {
  return new Environment({
    network: Network.create(() => Promise.resolve({ data: {} })),
    store: new Store(new RecordSource()),
  });
}

function createPost(store: RecordSourceProxy) {
  const post = store.create("post", "Note");
  const engagementStats = store.create("post-stats", "PostEngagementStats");
  engagementStats.setValue(4, "reactions");
  post.setLinkedRecord(engagementStats, "engagementStats");
  post.setLinkedRecords([], "reactionGroups");
  return { post, engagementStats };
}

function createGroup(
  store: RecordSourceProxy,
  target: ReactionTarget,
  count: number,
) {
  const group = store.create(`group-${target.id}`, "EmojiReactionGroup");
  if (target.kind === "emoji") {
    group.setValue(target.id, "emoji");
  } else {
    const customEmoji = store.create(target.id, "CustomEmoji");
    group.setLinkedRecord(customEmoji, "customEmoji");
  }
  const reactors = store.create(
    `group-${target.id}-reactors`,
    "ReactionGroupReactorsConnection",
  );
  reactors.setValue(count, "totalCount");
  group.setLinkedRecord(reactors, "reactors");
  return { group, reactors };
}

test("adds an existing reaction group", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);
    const target = { kind: "emoji", id: "🎉" } as const;
    const { group, reactors } = createGroup(store, target, 2);
    post.setLinkedRecords([group], "reactionGroups");

    assert.equal(
      updateReactionStore(store, {
        action: "add",
        postId: post.getDataID(),
        target,
        actingAccountId: "account",
      }),
      true,
    );
    assert.equal(engagementStats.getValue("reactions"), 5);
    assert.equal(reactors.getValue("totalCount"), 3);
    assert.equal(
      reactors.getValue("viewerHasReacted", {
        actingAccountId: "account",
      }),
      true,
    );
  });
});

test("creates a missing unicode reaction group", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);

    assert.equal(
      updateReactionStore(store, {
        action: "add",
        postId: post.getDataID(),
        target: { kind: "emoji", id: "❤️" },
      }),
      true,
    );
    const [group] = post.getLinkedRecords("reactionGroups") ?? [];
    const reactors = group?.getLinkedRecord("reactors");
    assert.equal(engagementStats.getValue("reactions"), 5);
    assert.equal(group?.getValue("emoji"), "❤️");
    assert.equal(group?.getLinkedRecord("subject")?.getDataID(), "post");
    assert.equal(reactors?.getValue("totalCount"), 1);
    assert.equal(reactors?.getValue("viewerHasReacted", null), true);
  });
});

test("does not create a missing custom reaction group", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);

    assert.equal(
      updateReactionStore(store, {
        action: "add",
        postId: post.getDataID(),
        target: { kind: "customEmoji", id: "custom" },
      }),
      false,
    );
    assert.equal(engagementStats.getValue("reactions"), 4);
    assert.deepEqual(post.getLinkedRecords("reactionGroups"), []);
  });
});

test("removes a reaction from a populated group", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);
    const target = { kind: "customEmoji", id: "custom" } as const;
    const { group, reactors } = createGroup(store, target, 3);
    post.setLinkedRecords([group], "reactionGroups");

    assert.equal(
      updateReactionStore(store, {
        action: "remove",
        postId: post.getDataID(),
        target,
      }),
      true,
    );
    assert.equal(engagementStats.getValue("reactions"), 3);
    assert.equal(reactors.getValue("totalCount"), 2);
    assert.equal(reactors.getValue("viewerHasReacted", null), false);
    assert.deepEqual(post.getLinkedRecords("reactionGroups"), [group]);
  });
});

test("removes the final reaction group and its records", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);
    const target = { kind: "emoji", id: "👀" } as const;
    const { group, reactors } = createGroup(store, target, 1);
    const groupId = group.getDataID();
    const reactorsId = reactors.getDataID();
    post.setLinkedRecords([group], "reactionGroups");

    assert.equal(
      updateReactionStore(store, {
        action: "remove",
        postId: post.getDataID(),
        target,
      }),
      true,
    );
    assert.equal(engagementStats.getValue("reactions"), 3);
    assert.deepEqual(post.getLinkedRecords("reactionGroups"), []);
    assert.equal(store.get(groupId), null);
    assert.equal(store.get(reactorsId), null);
  });
});

test("leaves counts unchanged when a removal target is absent", () => {
  const env = environment();
  env.commitUpdate((store) => {
    const { post, engagementStats } = createPost(store);

    assert.equal(
      updateReactionStore(store, {
        action: "remove",
        postId: post.getDataID(),
        target: { kind: "emoji", id: "🤔" },
      }),
      false,
    );
    assert.equal(engagementStats.getValue("reactions"), 4);
  });
});

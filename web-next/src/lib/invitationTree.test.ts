import assert from "node:assert";
import test from "node:test";
import {
  buildInvitationTree,
  buildInvitationTreeSortHref,
  isNewInvitationTreeMember,
  NEW_MEMBER_WINDOW_MS,
  parseInvitationTreeSort,
} from "./invitationTree.ts";

test("parseInvitationTreeSort() falls back to the oldest signup order", () => {
  assert.equal(parseInvitationTreeSort(undefined), "OLDEST");
  assert.equal(parseInvitationTreeSort("unknown"), "OLDEST");
  assert.equal(parseInvitationTreeSort("newest"), "NEWEST");
  assert.equal(
    parseInvitationTreeSort("most-invitations"),
    "MOST_INVITATIONS",
  );
});

test("buildInvitationTreeSortHref() preserves unrelated query parameters", () => {
  assert.equal(
    buildInvitationTreeSortHref(
      "/tree",
      "?lang=ko-KR&sort=newest",
      "OLDEST",
    ),
    "/tree?lang=ko-KR",
  );
  assert.equal(
    buildInvitationTreeSortHref("/tree", "?lang=ko-KR", "NEWEST"),
    "/tree?lang=ko-KR&sort=newest",
  );
  assert.equal(
    buildInvitationTreeSortHref(
      "/tree",
      "?lang=ko-KR",
      "MOST_INVITATIONS",
    ),
    "/tree?lang=ko-KR&sort=most-invitations",
  );
});

const nodes = [
  { id: "root-old" },
  { id: "root-new" },
  { id: "child-old", inviterId: "root-old" },
  { id: "child-popular", inviterId: "root-old" },
  { id: "child-new", inviterId: "root-old" },
  { id: "other-branch", inviterId: "root-new" },
  { id: "grandchild-old", inviterId: "child-popular" },
  { id: "grandchild-new", inviterId: "child-popular" },
] as const;

function ids(
  tree: Map<string | null, readonly { id: string }[]>,
  parent: string | null,
) {
  return (tree.get(parent) ?? []).map((node) => node.id);
}

test("buildInvitationTree() sorts each direct-child group independently", () => {
  const oldest = buildInvitationTree(nodes, "OLDEST");
  assert.deepEqual(ids(oldest, null), ["root-old", "root-new"]);
  assert.deepEqual(ids(oldest, "root-old"), [
    "child-old",
    "child-popular",
    "child-new",
  ]);
  assert.deepEqual(ids(oldest, "root-new"), ["other-branch"]);

  const newest = buildInvitationTree(nodes, "NEWEST");
  assert.deepEqual(ids(newest, null), ["root-new", "root-old"]);
  assert.deepEqual(ids(newest, "root-old"), [
    "child-new",
    "child-popular",
    "child-old",
  ]);
  assert.deepEqual(ids(newest, "root-new"), ["other-branch"]);
});

test("buildInvitationTree() sorts by direct invitations then oldest signup", () => {
  const tree = buildInvitationTree(nodes, "MOST_INVITATIONS");
  assert.deepEqual(ids(tree, null), ["root-old", "root-new"]);
  assert.deepEqual(ids(tree, "root-old"), [
    "child-popular",
    "child-old",
    "child-new",
  ]);
  assert.deepEqual(ids(tree, "child-popular"), [
    "grandchild-old",
    "grandchild-new",
  ]);
});

test("isNewInvitationTreeMember() applies an exact 70-day window", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  assert.equal(
    isNewInvitationTreeMember(
      new Date(now.getTime() - NEW_MEMBER_WINDOW_MS + 1),
      now,
    ),
    true,
  );
  assert.equal(
    isNewInvitationTreeMember(
      new Date(now.getTime() - NEW_MEMBER_WINDOW_MS),
      now,
    ),
    false,
  );
  assert.equal(isNewInvitationTreeMember(null, now), false);
  assert.equal(
    isNewInvitationTreeMember(new Date(now.getTime() + 1), now),
    false,
  );
});

import type {
  RecordProxy,
  RecordSourceProxy,
  RecordSourceSelectorProxy,
} from "relay-runtime";
import type { ReactionMutationAction } from "./reactionMutationResult.ts";

/** A unicode or custom emoji reaction target. */
export interface ReactionTarget {
  readonly kind: "emoji" | "customEmoji";
  readonly id: string;
}

export interface ReactionStoreUpdate {
  readonly action: ReactionMutationAction;
  readonly postId: string;
  readonly target: ReactionTarget;
  readonly actingAccountId?: string | null;
}

type RelayStoreProxy = RecordSourceProxy | RecordSourceSelectorProxy;

function viewerReactionArgs(actingAccountId: string | null | undefined) {
  return actingAccountId == null ? null : { actingAccountId };
}

function findGroupIndex(
  groups: ReadonlyArray<RecordProxy | null | undefined>,
  target: ReactionTarget,
): number {
  return groups.findIndex((group) =>
    target.kind === "emoji"
      ? group?.getValue("emoji") === target.id
      : group?.getLinkedRecord("customEmoji")?.getDataID() === target.id,
  );
}

function updateReactionCount(post: RecordProxy, delta: -1 | 1): void {
  const engagementStats = post.getLinkedRecord("engagementStats");
  if (engagementStats == null) return;

  const current = (engagementStats.getValue("reactions") as number) || 0;
  engagementStats.setValue(Math.max(0, current + delta), "reactions");
}

/**
 * Applies one successful reaction mutation to the Relay store.
 *
 * Returns `false` without changing aggregate counts when the target records
 * needed for the transition are absent. Custom emoji choices always come from
 * existing groups, while unicode choices may create a new group locally.
 */
export function updateReactionStore(
  store: RelayStoreProxy,
  update: ReactionStoreUpdate,
): boolean {
  const post = store.get(update.postId);
  if (post == null) return false;

  const reactionGroups = post.getLinkedRecords("reactionGroups") ?? [];
  const groupIndex = findGroupIndex(reactionGroups, update.target);
  const group = groupIndex < 0 ? null : reactionGroups[groupIndex];
  const viewerArgs = viewerReactionArgs(update.actingAccountId);

  if (update.action === "remove") {
    if (group == null) return false;

    const reactors = group.getLinkedRecord("reactors");
    const count = (reactors?.getValue("totalCount") as number) || 0;
    if (count <= 1) {
      post.setLinkedRecords(
        reactionGroups.filter((_, index) => index !== groupIndex),
        "reactionGroups",
      );
      if (reactors != null) store.delete(reactors.getDataID());
      store.delete(group.getDataID());
    } else {
      reactors?.setValue(count - 1, "totalCount");
      reactors?.setValue(false, "viewerHasReacted", viewerArgs);
    }
    updateReactionCount(post, -1);
    return true;
  }

  if (group != null) {
    let reactors = group.getLinkedRecord("reactors");
    if (reactors == null) {
      reactors = store.create(
        `${update.postId}_reaction_${update.target.id}_reactors`,
        "ReactionGroupReactorsConnection",
      );
      group.setLinkedRecord(reactors, "reactors");
    }
    const count = (reactors.getValue("totalCount") as number) || 0;
    reactors.setValue(count + 1, "totalCount");
    reactors.setValue(true, "viewerHasReacted", viewerArgs);
  } else if (update.target.kind === "emoji") {
    const newGroup = store.create(
      `${update.postId}_reaction_${update.target.id}`,
      "EmojiReactionGroup",
    );
    const reactors = store.create(
      `${update.postId}_reaction_${update.target.id}_reactors`,
      "ReactionGroupReactorsConnection",
    );
    newGroup.setValue(update.target.id, "emoji");
    reactors.setValue(1, "totalCount");
    reactors.setValue(true, "viewerHasReacted", viewerArgs);
    newGroup.setLinkedRecord(reactors, "reactors");
    newGroup.setLinkedRecord(post, "subject");
    post.setLinkedRecords([...reactionGroups, newGroup], "reactionGroups");
  } else {
    return false;
  }

  updateReactionCount(post, 1);
  return true;
}

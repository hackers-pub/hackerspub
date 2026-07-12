export type InvitationTreeSort =
  | "OLDEST"
  | "NEWEST"
  | "MOST_INVITATIONS";

const SLUG_TO_SORT: Record<string, InvitationTreeSort> = {
  oldest: "OLDEST",
  newest: "NEWEST",
  "most-invitations": "MOST_INVITATIONS",
};

const SORT_TO_SLUG: Record<InvitationTreeSort, string> = {
  OLDEST: "oldest",
  NEWEST: "newest",
  MOST_INVITATIONS: "most-invitations",
};

export const INVITATION_TREE_SORTS: InvitationTreeSort[] = [
  "OLDEST",
  "NEWEST",
  "MOST_INVITATIONS",
];

export const NEW_MEMBER_WINDOW_MS = 70 * 24 * 60 * 60 * 1000;

interface InvitationTreeNode {
  id: string;
  inviterId?: string | null;
}

export function parseInvitationTreeSort(
  value: string | undefined,
): InvitationTreeSort {
  return value == null ? "OLDEST" : SLUG_TO_SORT[value] ?? "OLDEST";
}

export function buildInvitationTreeSortHref(
  pathname: string,
  search: string,
  sort: InvitationTreeSort,
): string {
  const params = new URLSearchParams(search);
  if (sort === "OLDEST") params.delete("sort");
  else params.set("sort", SORT_TO_SLUG[sort]);
  const query = params.toString();
  return pathname + (query ? `?${query}` : "");
}

export function buildInvitationTree<T extends InvitationTreeNode>(
  nodes: readonly T[],
  sort: InvitationTreeSort,
): Map<string | null, T[]> {
  const tree = new Map<string | null, T[]>();
  const sourceOrder = new Map<string, number>();

  nodes.forEach((node, index) => {
    sourceOrder.set(node.id, index);
    const parentId = node.inviterId ?? null;
    const children = tree.get(parentId);
    if (children == null) tree.set(parentId, [node]);
    else children.push(node);
  });

  const compareSourceOrder = (a: T, b: T) =>
    sourceOrder.get(a.id)! - sourceOrder.get(b.id)!;

  for (const children of tree.values()) {
    children.sort((a, b) => {
      if (sort === "NEWEST") return -compareSourceOrder(a, b);
      if (sort === "MOST_INVITATIONS") {
        const invitationDifference = (tree.get(b.id)?.length ?? 0) -
          (tree.get(a.id)?.length ?? 0);
        return invitationDifference || compareSourceOrder(a, b);
      }
      return compareSourceOrder(a, b);
    });
  }

  return tree;
}

export function isNewInvitationTreeMember(
  created: string | Date | null | undefined,
  now = new Date(),
): boolean {
  if (created == null) return false;
  const createdTime = new Date(created).getTime();
  const age = now.getTime() - createdTime;
  return Number.isFinite(createdTime) && age >= 0 && age < NEW_MEMBER_WINDOW_MS;
}

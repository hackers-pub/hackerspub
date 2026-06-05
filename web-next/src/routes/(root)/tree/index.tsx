import { graphql } from "relay-runtime";
import { createMemo, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { treeQuery as treeQueryType } from "./__generated__/treeQuery.graphql.ts";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";

const TreeIndexQueryDocument = graphql`
  query treeQuery {
    invitationTree {
      id
      username
      name
      avatarUrl
      inviterId
      hidden
    }
  }
`;

const loadTreeIndexQuery = routePreloadedQuery(
  () =>
    loadQuery<treeQueryType>(
      useRelayEnvironment()(),
      TreeIndexQueryDocument,
      {},
    ),
  "loadTreeQuery",
);

interface TreeNode {
  id: string;
  username: string | null | undefined;
  name: string | null | undefined;
  avatarUrl: string;
  inviterId: string | null | undefined;
  hidden: boolean;
}

function buildTree(
  nodes: readonly TreeNode[],
): Map<string | null, TreeNode[]> {
  const tree = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const parentId = node.inviterId ?? null;
    if (!tree.has(parentId)) tree.set(parentId, []);
    tree.get(parentId)!.push(node);
  }

  return tree;
}

interface LeafProps {
  tree: Map<string | null, TreeNode[]>;
  parentId: string | null;
  class?: string;
}

function Leaf(props: LeafProps) {
  const children = () => props.tree.get(props.parentId) ?? [];

  return (
    <ul class={props.class}>
      <For each={children()}>
        {(account) => {
          const inviteCount = () => props.tree.get(account.id)?.length ?? 0;
          return (
            <li class="relative pt-4 pl-7 border-l border-border last:border-l-0 last:before:content-['.'] last:before:absolute last:before:text-transparent last:before:border-l last:before:border-border last:before:h-12 last:before:ml-[-1.75rem] last:before:mt-[-1rem]">
              <div class="flex items-start gap-3 before:content-['.'] before:absolute before:text-transparent before:border-t before:border-border before:w-7 before:mt-6 before:ml-[-1.75rem]">
                {account.hidden
                  ? <HiddenNode username={account.username} />
                  : (
                    <VisibleNode
                      user={account}
                      inviteCount={inviteCount()}
                    />
                  )}
              </div>
              {(props.tree.get(account.id)?.length ?? 0) > 0 && (
                <Leaf
                  tree={props.tree}
                  parentId={account.id}
                  class="ml-7"
                />
              )}
            </li>
          );
        }}
      </For>
    </ul>
  );
}

function HiddenNode(_props: { username?: string | null }) {
  const { t } = useLingui();
  return (
    <>
      <div class="shrink-0 size-12 rounded-full bg-muted flex items-center justify-center border border-border border-dashed">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-5 text-muted-foreground"
        >
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          <circle cx="12" cy="16" r="1" />
        </svg>
      </div>
      <div class="flex flex-col min-w-0">
        <strong class="text-sm">{t`Hidden account`}</strong>
        <span class="text-sm text-muted-foreground">
          {t`This account is hidden because they want to keep their identity private.`}
        </span>
      </div>
    </>
  );
}

function VisibleNode(props: { user: TreeNode; inviteCount: number }) {
  return (
    <>
      <A
        href={`/@${props.user.username}`}
        class="shrink-0 size-12 rounded-full overflow-hidden border border-border"
      >
        <img
          src={props.user.avatarUrl}
          class="size-full object-cover"
          alt=""
        />
      </A>
      <div class="flex flex-col min-w-0">
        <A
          href={`/@${props.user.username}`}
          class="font-semibold text-sm leading-tight"
        >
          {props.user.name ?? props.user.username}
        </A>
        <span class="text-sm text-muted-foreground">
          <A
            href={`/@${props.user.username}`}
            class="hover:underline"
          >
            @{props.user.username}
          </A>{" "}
          &middot; <InvitedCount count={props.inviteCount} />
        </span>
      </div>
    </>
  );
}

function InvitedCount(props: { count: number }) {
  const { i18n } = useLingui();
  return (
    <>
      {i18n._(
        msg`${
          plural(props.count, {
            one: "Invited # person",
            other: "Invited # people",
          })
        }`,
      )}
    </>
  );
}

export default function InvitationTree() {
  const { t } = useLingui();
  const data = createStablePreloadedQuery<treeQueryType>(
    TreeIndexQueryDocument,
    () => loadTreeIndexQuery(),
  );

  const tree = createMemo(() => {
    const queryData = data();
    if (!queryData) return new Map<string | null, TreeNode[]>();
    return buildTree(queryData.invitationTree);
  });

  const roots = () => tree().get(null) ?? [];

  return (
    <div class="container px-8 max-sm:px-4 py-8">
      <div class="flex items-center gap-6 mb-6">
        <h1 class="text-xl font-semibold">
          {t`Invitation tree`}
        </h1>
        <div class="flex gap-1 border border-border rounded-md p-0.5">
          <A
            href="/tree"
            class="px-3 py-1 text-sm font-medium rounded-sm bg-accent text-accent-foreground"
          >
            {t`Tree`}
          </A>
          <A
            href="/tree/graph"
            class="px-3 py-1 text-sm font-medium rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {t`Graph`}
          </A>
        </div>
      </div>
      <Show
        when={roots().length > 0}
        fallback={
          <p class="text-sm text-muted-foreground">
            {t`No invitation tree data yet.`}
          </p>
        }
      >
        <Leaf tree={tree()} parentId={null} class="mt-4" />
      </Show>
    </div>
  );
}

import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ForceGraph } from "~/components/ForceGraph.tsx";
import type { treeQuery } from "./__generated__/treeQuery.graphql.ts";

export const route = {
  preload() {
    void loadTreeQuery();
  },
} satisfies RouteDefinition;

const TreeQueryDocument = graphql`
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

const loadTreeQuery = query(
  () => loadQuery<treeQuery>(useRelayEnvironment()(), TreeQueryDocument, {}),
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

function transformToGraphData(treeData: readonly TreeNode[]) {
  const nodes = treeData.map((node) => ({
    id: node.id,
    username: node.username ?? undefined,
    name: node.name ?? undefined,
    avatarUrl: node.avatarUrl,
    hidden: node.hidden,
  }));

  const links = treeData
    .filter((node) => node.inviterId != null)
    .map((node) => ({
      source: node.inviterId!,
      target: node.id,
      value: 1,
    }));

  return { nodes, links };
}

export default function Tree() {
  const data = createPreloadedQuery<treeQuery>(
    TreeQueryDocument,
    () => loadTreeQuery(),
  );

  return (
    <div class="h-full flex flex-col">
      <div class="border overflow-hidden w-full max-h-full flex-1">
        <Show when={data()}>
          {(queryData) => (
            <ForceGraph
              data={transformToGraphData(queryData().invitationTree)}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

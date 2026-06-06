import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { A } from "@solidjs/router";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ForceGraph } from "~/components/ForceGraph.tsx";
import type { graphQuery as graphQueryType } from "./__generated__/graphQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

const TreeGraphQueryDocument = graphql`
  query graphQuery {
    invitationTree {
      id
      username
      name
      handle
      avatarUrl
      inviterId
      hidden
    }
  }
`;

const loadTreeGraphQuery = routePreloadedQuery(
  () =>
    loadQuery<graphQueryType>(
      useRelayEnvironment()(),
      TreeGraphQueryDocument,
      {},
    ),
  "loadGraphQuery",
);

interface TreeNode {
  id: string;
  username: string | null | undefined;
  name: string | null | undefined;
  handle: string | null | undefined;
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

export default function InvitationTreeGraph() {
  const { t } = useLingui();
  const data = createStablePreloadedQuery<graphQueryType>(
    TreeGraphQueryDocument,
    () => loadTreeGraphQuery(),
  );

  return (
    <div class="h-full flex flex-col">
      <div class="container px-8 max-sm:px-4 py-8">
        <div class="flex items-center gap-6 mb-6">
          <h1 class="text-xl font-semibold">
            {t`Invitation tree`}
          </h1>
          <div class="flex gap-1 border border-border rounded-md p-0.5">
            <A
              href="/tree"
              class="px-3 py-1 text-sm font-medium rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {t`Tree`}
            </A>
            <A
              href="/tree/graph"
              class="px-3 py-1 text-sm font-medium rounded-sm bg-accent text-accent-foreground"
            >
              {t`Graph`}
            </A>
          </div>
        </div>
      </div>
      <div class="border-b border-border mx-8 max-sm:mx-4" />
      <div class="border overflow-hidden w-full flex-1">
        <Show keyed when={data()}>
          {(queryData) => (
            <ForceGraph
              data={transformToGraphData(queryData.invitationTree)}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

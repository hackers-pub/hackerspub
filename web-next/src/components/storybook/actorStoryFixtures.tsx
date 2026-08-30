import {
  createOperationDescriptor,
  Environment,
  getRequest,
  type GraphQLTaggedNode,
  Network,
  RecordSource,
  Store,
  type Variables,
} from "relay-runtime";
import { MockPayloadGenerator, type MockResolvers } from "relay-test-utils";
import type { JSX } from "solid-js";

export const defaultActorHandle = "@cloudflare@hackers.pub";
export const defaultActorName = "Cloudflare Blog Feed";
export const longActorHandle = "@blog_cloudflare_com_rs_5i8zpek@beta.rss2.pub";

export const actorAvatarDataUri =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
      '<rect width="80" height="80" rx="16" fill="#f38020"/>' +
      '<text x="40" y="50" text-anchor="middle" font-family="sans-serif" ' +
      'font-size="28" font-weight="700" fill="white">CF</text></svg>',
  );

export interface ActorStoryArgs {
  handle: string;
  name: string;
  width: number;
}

interface StorySurfaceProps {
  children: JSX.Element;
  width: number;
}

export function StorySurface(props: StorySurfaceProps) {
  return (
    <div
      class="border bg-background"
      style={{ width: `${props.width}px`, "max-width": "100%" }}
    >
      {props.children}
    </div>
  );
}

export function actorMockResolvers(
  args: Pick<ActorStoryArgs, "handle" | "name">,
  nodeType: "Actor" | "Note" = "Actor",
): MockResolvers {
  return {
    Node: () => ({ __typename: nodeType }),
    Actor: () => ({
      id: "story-actor",
      name: args.name,
      rawName: args.name,
      username: "blog_cloudflare_com_rs_5i8zpek",
      handle: args.handle,
      avatarUrl: actorAvatarDataUri,
      avatarInitials: "CF",
      bio: "<p>Engineering updates from the Cloudflare blog.</p>",
      local: false,
      url: "https://beta.rss2.pub/@blog_cloudflare_com_rs_5i8zpek",
      iri: "https://beta.rss2.pub/ap/actors/blog_cloudflare_com_rs_5i8zpek",
      suspended: false,
      successor: null,
      account: null,
      fields: [],
      isViewer: false,
      viewerFollows: false,
      viewerFollowState: "NONE",
      viewerBlocks: false,
      blocksViewer: false,
      viewerMutes: false,
      followsViewer: false,
      followees: { totalCount: 42 },
      followers: { totalCount: 128 },
      mutualFollowers: { totalCount: 0, edges: [] },
    }),
    Note: () => ({
      id: "story-post",
      organizationAuthor: null,
    }),
  };
}

export function createRelayStoryData<
  TResponse extends { readonly node?: unknown | null },
>(
  query: GraphQLTaggedNode,
  variables: Variables,
  resolvers: MockResolvers,
  subject: string,
): {
  environment: Environment;
  node: NonNullable<TResponse["node"]>;
} {
  const environment = new Environment({
    network: Network.create(() => {
      throw new Error("Storybook's mock environment has no real network");
    }),
    store: new Store(new RecordSource()),
  });
  const operation = createOperationDescriptor(getRequest(query), variables);
  const payload = MockPayloadGenerator.generate(operation, resolvers);
  if (payload.data == null) {
    throw new Error(`MockPayloadGenerator produced no ${subject} data`);
  }
  environment.commitPayload(operation, payload.data);
  const data = environment.lookup(operation.fragment).data as unknown as
    | TResponse
    | undefined;
  if (data?.node == null) {
    throw new Error(`${subject} story query produced no node`);
  }
  return {
    environment,
    node: data.node as NonNullable<TResponse["node"]>,
  };
}

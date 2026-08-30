import {
  createOperationDescriptor,
  Environment,
  getRequest,
  graphql,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";
import { MockPayloadGenerator, type MockResolvers } from "relay-test-utils";
import { RelayEnvironmentProvider } from "solid-relay";
import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountListBase } from "./AccountListBase.tsx";
import { ActorHandle } from "./ActorHandle.tsx";
import { ActorPreviewCard } from "./ActorPreviewCard.tsx";
import type { ActorHandleStoriesActorQuery } from "./__generated__/ActorHandleStoriesActorQuery.graphql.ts";
import type { ActorHandleStoriesPostQuery } from "./__generated__/ActorHandleStoriesPostQuery.graphql.ts";
import { LinkCreatorAttribution } from "./LinkCreatorAttribution.tsx";
import { PostAuthorLine } from "./PostAuthor.tsx";
import { ProfileCard } from "./ProfileCard.tsx";
import { SmallProfileCard } from "./SmallProfileCard.tsx";

const ActorHandleStoriesActorQuery = graphql`
  query ActorHandleStoriesActorQuery($id: ID!, $actingAccountId: ID) {
    node(id: $id) {
      ... on Actor {
        ...ActorPreviewCard_actor
          @arguments(actingAccountId: $actingAccountId)
        ...LinkCreatorAttribution_creator
        ...ProfileCard_actor @arguments(actingAccountId: $actingAccountId)
        ...SmallProfileCard_actor
          @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

const ActorHandleStoriesPostQuery = graphql`
  query ActorHandleStoriesPostQuery($id: ID!) {
    node(id: $id) {
      ... on Post {
        ...PostAuthorLine_post
      }
    }
  }
`;

const longHandle = "@blog_cloudflare_com_rs_5i8zpek@beta.rss2.pub";
const defaultName = "Cloudflare Blog Feed";

const avatarDataUri =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
      '<rect width="80" height="80" rx="16" fill="#f38020"/>' +
      '<text x="40" y="50" text-anchor="middle" font-family="sans-serif" ' +
      'font-size="28" font-weight="700" fill="white">CF</text></svg>',
  );

interface ActorHandleStoryArgs {
  handle: string;
  name: string;
  width: number;
}

interface StorySurfaceProps {
  children: JSX.Element;
  width: number;
}

function StorySurface(props: StorySurfaceProps) {
  return (
    <div
      class="border bg-background"
      style={{ width: `${props.width}px`, "max-width": "100%" }}
    >
      {props.children}
    </div>
  );
}

function actorResolvers(
  handle: string,
  name: string,
  nodeType: "Actor" | "Note",
): MockResolvers {
  return {
    Node: () => ({ __typename: nodeType }),
    Actor: () => ({
      id: "story-actor",
      name,
      rawName: name,
      username: "blog_cloudflare_com_rs_5i8zpek",
      handle,
      avatarUrl: avatarDataUri,
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

function actorStoryData(handle: string, name: string) {
  const environment = new Environment({
    network: Network.create(() => {
      throw new Error("Storybook's mock environment has no real network");
    }),
    store: new Store(new RecordSource()),
  });
  const operation = createOperationDescriptor(
    getRequest(ActorHandleStoriesActorQuery),
    { id: "story-actor", actingAccountId: null },
  );
  const payload = MockPayloadGenerator.generate(
    operation,
    actorResolvers(handle, name, "Actor"),
  );
  if (payload.data == null) {
    throw new Error("MockPayloadGenerator produced no actor data");
  }
  environment.commitPayload(operation, payload.data);
  const data = environment.lookup(operation.fragment).data as unknown as
    | ActorHandleStoriesActorQuery["response"]
    | undefined;
  if (data?.node == null) {
    throw new Error("Actor story query produced no actor");
  }
  return { actor: data.node, environment };
}

function postStoryData(handle: string, name: string) {
  const environment = new Environment({
    network: Network.create(() => {
      throw new Error("Storybook's mock environment has no real network");
    }),
    store: new Store(new RecordSource()),
  });
  const operation = createOperationDescriptor(
    getRequest(ActorHandleStoriesPostQuery),
    { id: "story-post" },
  );
  const payload = MockPayloadGenerator.generate(
    operation,
    actorResolvers(handle, name, "Note"),
  );
  if (payload.data == null) {
    throw new Error("MockPayloadGenerator produced no post data");
  }
  environment.commitPayload(operation, payload.data);
  const data = environment.lookup(operation.fragment).data as unknown as
    | ActorHandleStoriesPostQuery["response"]
    | undefined;
  if (data?.node == null) {
    throw new Error("Post story query produced no post");
  }
  return { environment, post: data.node };
}

const meta = {
  title: "Regressions/Actor handle layouts",
  args: {
    handle: longHandle,
    name: defaultName,
    width: 360,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<ActorHandleStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WrappingHandle: Story = {
  name: "ActorHandle: wrapping",
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <div class="p-4 text-muted-foreground">
        <ActorHandle handle={args.handle} class="block wrap-anywhere" />
      </div>
    </StorySurface>
  ),
};

export const TruncatedHandle: Story = {
  name: "ActorHandle: truncation",
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <div class="min-w-0 p-4 text-muted-foreground">
        <ActorHandle handle={args.handle} class="block truncate" />
      </div>
    </StorySurface>
  ),
};

export const ProfileAtDesktopWidth: Story = {
  name: "ProfileCard: long handle at desktop width",
  args: { width: 640 },
  render: (args: ActorHandleStoryArgs) => {
    const { actor, environment } = actorStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <ProfileCard $actor={actor} />
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const ProfileAtMobileWidth: Story = {
  name: "ProfileCard: long handle at mobile width",
  args: { width: 320 },
  render: (args: ActorHandleStoryArgs) => {
    const { actor, environment } = actorStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <ProfileCard $actor={actor} />
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const SmallProfile: Story = {
  name: "SmallProfileCard: truncated handle",
  render: (args: ActorHandleStoryArgs) => {
    const { actor, environment } = actorStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <SmallProfileCard $actor={actor} />
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const ActorPreview: Story = {
  name: "ActorPreviewCard: truncated handle",
  args: { width: 320 },
  render: (args: ActorHandleStoryArgs) => {
    const { actor, environment } = actorStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <ActorPreviewCard $actor={actor} />
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const PostAuthor: Story = {
  name: "PostAuthorLine: truncated handle",
  args: { width: 280 },
  render: (args: ActorHandleStoryArgs) => {
    const { environment, post } = postStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <div class="min-w-0 p-4">
            <PostAuthorLine $post={post} />
          </div>
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const LinkCreator: Story = {
  name: "LinkCreatorAttribution: wrapping handle",
  args: { width: 280 },
  render: (args: ActorHandleStoryArgs) => {
    const { actor, environment } = actorStoryData(args.handle, args.name);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <StorySurface width={args.width}>
          <div class="p-4">
            <LinkCreatorAttribution $creator={actor} />
          </div>
        </StorySurface>
      </RelayEnvironmentProvider>
    );
  },
};

export const AccountList: Story = {
  name: "AccountListBase: truncated handle",
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <AccountListBase
        edges={[
          {
            node: {
              id: "story-actor",
              avatarUrl: avatarDataUri,
              name: args.name,
              handle: args.handle,
              local: false,
              username: "blog_cloudflare_com_rs_5i8zpek",
            },
          },
        ]}
        hasNext={false}
        pending={false}
        loadingState="loaded"
        onLoadMore={() => undefined}
        onAction={() => undefined}
        actionLabel="Unblock"
        actionDisabled={false}
        emptyMessage="No accounts"
      />
    </StorySurface>
  ),
};

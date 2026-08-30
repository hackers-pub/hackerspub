import { graphql } from "relay-runtime";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { PostAuthorStoriesQuery } from "./__generated__/PostAuthorStoriesQuery.graphql.ts";
import { PostAuthorLine, type PostAuthorLineProps } from "./PostAuthor.tsx";
import {
  type ActorStoryArgs,
  actorMockResolvers,
  createRelayStoryData,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface PostAuthorStoryArgs extends ActorStoryArgs, PostAuthorLineProps {}

const PostAuthorStoriesQuery = graphql`
  query PostAuthorStoriesQuery($id: ID!) {
    node(id: $id) {
      ... on Post {
        ...PostAuthorLine_post
      }
    }
  }
`;

function renderPostAuthorLine(args: PostAuthorStoryArgs) {
  const { environment, node } = createRelayStoryData<
    PostAuthorStoriesQuery["response"]
  >(
    PostAuthorStoriesQuery,
    { id: "story-post" },
    actorMockResolvers(args, "Note"),
    "post",
  );
  return (
    <RelayEnvironmentProvider environment={environment}>
      <StorySurface width={args.width}>
        <div class="min-w-0 p-4">
          <PostAuthorLine $post={node} />
        </div>
      </StorySurface>
    </RelayEnvironmentProvider>
  );
}

const meta = {
  title: "Components/PostAuthor",
  component: PostAuthorLine,
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 280,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderPostAuthorLine,
} satisfies Meta<PostAuthorStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

import { graphql } from "relay-runtime";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ActorPreviewCard } from "./ActorPreviewCard.tsx";
import type { ActorPreviewCardStoriesQuery } from "./__generated__/ActorPreviewCardStoriesQuery.graphql.ts";
import {
  type ActorStoryArgs,
  actorMockResolvers,
  createRelayStoryData,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface ActorPreviewCardStoryArgs extends ActorStoryArgs {}

const ActorPreviewCardStoriesQuery = graphql`
  query ActorPreviewCardStoriesQuery($id: ID!, $actingAccountId: ID) {
    node(id: $id) {
      ... on Actor {
        ...ActorPreviewCard_actor
          @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

function renderActorPreviewCard(args: ActorPreviewCardStoryArgs) {
  const { environment, node } = createRelayStoryData<
    ActorPreviewCardStoriesQuery["response"]
  >(
    ActorPreviewCardStoriesQuery,
    { id: "story-actor", actingAccountId: null },
    actorMockResolvers(args),
    "actor",
  );
  return (
    <RelayEnvironmentProvider environment={environment}>
      <StorySurface width={args.width}>
        <ActorPreviewCard $actor={node} />
      </StorySurface>
    </RelayEnvironmentProvider>
  );
}

const meta = {
  title: "Components/ActorPreviewCard",
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 320,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderActorPreviewCard,
} satisfies Meta<ActorPreviewCardStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

import { graphql } from "relay-runtime";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SmallProfileCardStoriesQuery } from "./__generated__/SmallProfileCardStoriesQuery.graphql.ts";
import { SmallProfileCard } from "./SmallProfileCard.tsx";
import {
  type ActorStoryArgs,
  actorMockResolvers,
  createRelayStoryData,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface SmallProfileCardStoryArgs extends ActorStoryArgs {}

const SmallProfileCardStoriesQuery = graphql`
  query SmallProfileCardStoriesQuery($id: ID!, $actingAccountId: ID) {
    node(id: $id) {
      ... on Actor {
        ...SmallProfileCard_actor
          @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

function renderSmallProfileCard(args: SmallProfileCardStoryArgs) {
  const { environment, node } = createRelayStoryData<
    SmallProfileCardStoriesQuery["response"]
  >(
    SmallProfileCardStoriesQuery,
    { id: "story-actor", actingAccountId: null },
    actorMockResolvers(args),
    "actor",
  );
  return (
    <RelayEnvironmentProvider environment={environment}>
      <StorySurface width={args.width}>
        <SmallProfileCard $actor={node} />
      </StorySurface>
    </RelayEnvironmentProvider>
  );
}

const meta = {
  title: "Components/SmallProfileCard",
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 360,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderSmallProfileCard,
} satisfies Meta<SmallProfileCardStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

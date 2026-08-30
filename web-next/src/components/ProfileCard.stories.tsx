import { graphql } from "relay-runtime";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { ProfileCardStoriesQuery } from "./__generated__/ProfileCardStoriesQuery.graphql.ts";
import { ProfileCard } from "./ProfileCard.tsx";
import {
  type ActorStoryArgs,
  actorMockResolvers,
  createRelayStoryData,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface ProfileCardStoryArgs extends ActorStoryArgs {}

const ProfileCardStoriesQuery = graphql`
  query ProfileCardStoriesQuery($id: ID!, $actingAccountId: ID) {
    node(id: $id) {
      ... on Actor {
        ...ProfileCard_actor @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

function renderProfileCard(args: ProfileCardStoryArgs) {
  const { environment, node } = createRelayStoryData<
    ProfileCardStoriesQuery["response"]
  >(
    ProfileCardStoriesQuery,
    { id: "story-actor", actingAccountId: null },
    actorMockResolvers(args),
    "actor",
  );
  return (
    <RelayEnvironmentProvider environment={environment}>
      <StorySurface width={args.width}>
        <ProfileCard $actor={node} />
      </StorySurface>
    </RelayEnvironmentProvider>
  );
}

const meta = {
  title: "Components/ProfileCard",
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 640,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderProfileCard,
} satisfies Meta<ProfileCardStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

export const LongHandleAtMobileWidth: Story = {
  args: {
    handle: longActorHandle,
    width: 320,
  },
};

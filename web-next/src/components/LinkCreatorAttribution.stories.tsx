import { graphql } from "relay-runtime";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { LinkCreatorAttributionStoriesQuery } from "./__generated__/LinkCreatorAttributionStoriesQuery.graphql.ts";
import {
  LinkCreatorAttribution,
  type LinkCreatorAttributionProps,
} from "./LinkCreatorAttribution.tsx";
import {
  type ActorStoryArgs,
  actorMockResolvers,
  createRelayStoryData,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface LinkCreatorAttributionStoryArgs
  extends ActorStoryArgs, LinkCreatorAttributionProps {}

const LinkCreatorAttributionStoriesQuery = graphql`
  query LinkCreatorAttributionStoriesQuery($id: ID!) {
    node(id: $id) {
      ... on Actor {
        ...LinkCreatorAttribution_creator
      }
    }
  }
`;

function renderLinkCreatorAttribution(args: LinkCreatorAttributionStoryArgs) {
  const { environment, node } = createRelayStoryData<
    LinkCreatorAttributionStoriesQuery["response"]
  >(
    LinkCreatorAttributionStoriesQuery,
    { id: "story-actor" },
    actorMockResolvers(args),
    "actor",
  );
  return (
    <RelayEnvironmentProvider environment={environment}>
      <StorySurface width={args.width}>
        <div class="p-4">
          <LinkCreatorAttribution $creator={node} />
        </div>
      </StorySurface>
    </RelayEnvironmentProvider>
  );
}

const meta = {
  title: "Components/LinkCreatorAttribution",
  component: LinkCreatorAttribution,
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 280,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderLinkCreatorAttribution,
} satisfies Meta<LinkCreatorAttributionStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

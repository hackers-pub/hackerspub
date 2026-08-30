import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ActorHandle, type ActorHandleProps } from "./ActorHandle.tsx";
import {
  defaultActorHandle,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface ActorHandleStoryArgs extends ActorHandleProps {
  width: number;
}

const meta = {
  title: "Components/ActorHandle",
  component: ActorHandle,
  args: {
    handle: defaultActorHandle,
    width: 360,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
} satisfies Meta<ActorHandleStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <div class="p-4 text-muted-foreground">
        <ActorHandle handle={args.handle} />
      </div>
    </StorySurface>
  ),
};

export const Wrapping: Story = {
  args: { handle: longActorHandle },
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <div class="p-4 text-muted-foreground">
        <ActorHandle handle={args.handle} class="block wrap-anywhere" />
      </div>
    </StorySurface>
  ),
};

export const Truncated: Story = {
  args: { handle: longActorHandle },
  render: (args: ActorHandleStoryArgs) => (
    <StorySurface width={args.width}>
      <div class="min-w-0 p-4 text-muted-foreground">
        <ActorHandle handle={args.handle} class="block truncate" />
      </div>
    </StorySurface>
  ),
};

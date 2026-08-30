import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountListBase } from "./AccountListBase.tsx";
import {
  type ActorStoryArgs,
  actorAvatarDataUri,
  defaultActorHandle,
  defaultActorName,
  longActorHandle,
  StorySurface,
} from "./storybook/actorStoryFixtures.tsx";

interface AccountListStoryArgs extends ActorStoryArgs {}

function renderAccountList(args: AccountListStoryArgs) {
  return (
    <StorySurface width={args.width}>
      <AccountListBase
        edges={[
          {
            node: {
              id: "story-actor",
              avatarUrl: actorAvatarDataUri,
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
  );
}

const meta = {
  title: "Components/AccountListBase",
  args: {
    handle: defaultActorHandle,
    name: defaultActorName,
    width: 360,
  },
  argTypes: {
    width: { control: { min: 240, max: 720, step: 8, type: "range" } },
  },
  parameters: { layout: "padded" },
  render: renderAccountList,
} satisfies Meta<AccountListStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongHandle: Story = {
  args: { handle: longActorHandle },
};

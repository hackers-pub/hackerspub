import type { Meta, StoryObj } from "storybook-solidjs-vite";

import { Button } from "./button.tsx";

const meta: Meta<typeof Button> = {
  title: "UI/Button",
  component: Button,
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: {
    variant: "default",
    size: "default",
    children: "Button",
  },
  render: (args) => <Button {...args} />,
};

export const ByVariant: Story = {
  name: "By variant",
  parameters: { controls: { disable: true } },
  render: () => (
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const BySize: Story = {
  name: "By size",
  parameters: { controls: { disable: true } },
  render: () => (
    <div class="flex flex-wrap items-center gap-2">
      <Button size="default">Default</Button>
      <Button size="sm">Small</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Icon">*</Button>
    </div>
  ),
};

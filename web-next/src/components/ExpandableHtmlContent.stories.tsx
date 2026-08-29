import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ExpandableHtmlContent } from "./ExpandableHtmlContent.tsx";

const meta = {
  title: "Components/ExpandableHtmlContent",
  component: ExpandableHtmlContent,
  render: (args) => (
    <div class="max-w-lg bg-background p-4">
      <ExpandableHtmlContent
        {...args}
        class="prose dark:prose-invert mt-1 break-words overflow-wrap"
      />
    </div>
  ),
} satisfies Meta<typeof ExpandableHtmlContent>;

export default meta;
type Story = StoryObj<typeof meta>;

const shortHtml = `
  <p>Just shipped a small fix for the timeline. Nothing dramatic, but it
  should make scrolling feel a bit smoother.</p>
`;

const longHtml = `
  <p>I've been thinking a lot about how we render long posts in the
  timeline lately, and I wanted to write up where my head is at.</p>
  <p>The core problem is simple: a handful of authors write genuinely long
  posts (think essay-length), and when one of those lands in the middle of
  a feed, it pushes every post below it far down the page. That's a bad
  experience for someone scrolling through a timeline looking for recent
  activity.</p>
  <p>At the same time, most posts are short, and we don't want to add any
  visual noise or a toggle that never does anything for the common case.</p>
  <p>So the approach here is to only show the "Show more" affordance when a
  post actually overflows a generous collapsed height, and to make that
  decision after measuring the real rendered height rather than guessing
  from character count, which breaks down badly with headings, code
  blocks, and lists.</p>
`;

const marginalOverflowHtml = `
  <p>Hackers' Pub을 사용하면서 불편한 점이나 버그, 기능 추가 제안 등을
  제보하실 때는 개인적으로 연락하는 것도 괜찮지만, 공식 이슈 트래커에
  이슈를 만들어 주시는 쪽이 좋습니다. 이슈는 영어가 아니어도 됩니다.</p>
  <ul>
    <li>서비스 전반, 서버, 웹 앱</li>
    <li>Android 앱</li>
    <li>iOS/iPadOS 앱</li>
  </ul>
  <p>감사합니다.</p>
`;

export const ShortContent: Story = {
  name: "Short content (no toggle)",
  args: {
    html: shortHtml,
  },
};

export const LongContent: Story = {
  name: "Long content (collapsed)",
  args: {
    html: longHtml,
  },
};

export const MarginalOverflow: Story = {
  name: "Marginal overflow (no toggle)",
  args: {
    html: marginalOverflowHtml,
    lang: "ko",
  },
};

import { createSignal, For, type JSX, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import IconBookmark from "~icons/lucide/bookmark";
import IconEllipsis from "~icons/lucide/ellipsis";
import IconMessageSquare from "~icons/lucide/message-square";
import IconRepeat2 from "~icons/lucide/repeat-2";
import {
  QuickReactionBar,
  type QuickReactionGroup,
} from "./QuickReactionBar.tsx";

const meta = {
  title: "Components/QuickReactionBar",
  component: QuickReactionBar,
} satisfies Meta<typeof QuickReactionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Stateful harness so the stories demonstrate the multi-reaction flow:
 * toggling an emoji updates counts and the selected highlight without
 * closing the bar, mirroring how the real mutation-backed component
 * would behave.
 */
function InteractiveQuickReactionBar(props: {
  initialReactions?: QuickReactionGroup[];
  disabled?: boolean;
}) {
  const [reactions, setReactions] = createSignal<QuickReactionGroup[]>(
    props.initialReactions ?? [],
  );
  const [fullPickerRequests, setFullPickerRequests] = createSignal(0);

  const handleToggle = (emoji: string) => {
    setReactions((current) => {
      const existing = current.find((group) => group.emoji === emoji);
      if (existing == null) {
        return [...current, { emoji, count: 1, viewerHasReacted: true }];
      }
      if (existing.viewerHasReacted) {
        if (existing.count <= 1) {
          return current.filter((group) => group.emoji !== emoji);
        }
        return current.map((group) =>
          group.emoji === emoji
            ? { ...group, count: group.count - 1, viewerHasReacted: false }
            : group,
        );
      }
      return current.map((group) =>
        group.emoji === emoji
          ? { ...group, count: group.count + 1, viewerHasReacted: true }
          : group,
      );
    });
  };

  const viewerReactions = () =>
    reactions().filter((group) => group.viewerHasReacted);
  const totalCount = () =>
    reactions().reduce((sum, group) => sum + group.count, 0);

  return (
    <div class="space-y-4">
      <div class="inline-flex items-center">
        <QuickReactionBar
          reactions={reactions()}
          disabled={props.disabled}
          onToggleReaction={handleToggle}
          onOpenFullPicker={() => setFullPickerRequests((n) => n + 1)}
        />
        <span class="px-1 text-xs text-muted-foreground tabular-nums">
          {totalCount()}
        </span>
      </div>
      <div class="text-xs text-muted-foreground space-y-1">
        <p>
          You reacted with:{" "}
          <Show when={viewerReactions().length > 0} fallback="(nothing yet)">
            <For each={viewerReactions()}>
              {(group) => <span class="mr-1 text-sm">{group.emoji}</span>}
            </For>
          </Show>
        </p>
        <Show when={fullPickerRequests() > 0}>
          <p>
            Full picker requested {fullPickerRequests()} time(s) — the real
            component would open the existing emoji popover here.
          </p>
        </Show>
      </div>
    </div>
  );
}

/** Headroom so the bar that pops above the trigger is not clipped. */
function StoryFrame(props: { children: JSX.Element }) {
  return <div class="pt-20 pl-4">{props.children}</div>;
}

/**
 * No reactions yet.  Hover the heart (or focus it with the keyboard) to
 * reveal the quick-pick bar; pick several emojis in a row — the bar
 * stays open because multiple reactions are allowed.
 */
export const Default: Story = {
  render: () => (
    <StoryFrame>
      <InteractiveQuickReactionBar />
    </StoryFrame>
  ),
};

/**
 * The post already has reactions and the viewer has reacted with two of
 * them: those show the selected highlight and can be removed in place,
 * while count badges surface the other reactors.
 */
export const WithExistingReactions: Story = {
  render: () => (
    <StoryFrame>
      <InteractiveQuickReactionBar
        initialReactions={[
          { emoji: "❤️", count: 12, viewerHasReacted: true },
          { emoji: "🎉", count: 3, viewerHasReacted: true },
          { emoji: "😂", count: 7, viewerHasReacted: false },
          { emoji: "👀", count: 1, viewerHasReacted: false },
        ]}
      />
    </StoryFrame>
  ),
};

/** The trigger is disabled (e.g. signed-out viewer): no bar on hover. */
export const Disabled: Story = {
  render: () => (
    <StoryFrame>
      <InteractiveQuickReactionBar disabled />
    </StoryFrame>
  ),
};

function FakeTimelineNote(props: {
  name: string;
  handle: string;
  body: string;
  initialReactions?: QuickReactionGroup[];
}) {
  const [reactions, setReactions] = createSignal<QuickReactionGroup[]>(
    props.initialReactions ?? [],
  );

  const handleToggle = (emoji: string) => {
    setReactions((current) => {
      const existing = current.find((group) => group.emoji === emoji);
      if (existing == null) {
        return [...current, { emoji, count: 1, viewerHasReacted: true }];
      }
      if (existing.viewerHasReacted) {
        if (existing.count <= 1) {
          return current.filter((group) => group.emoji !== emoji);
        }
        return current.map((group) =>
          group.emoji === emoji
            ? { ...group, count: group.count - 1, viewerHasReacted: false }
            : group,
        );
      }
      return current.map((group) =>
        group.emoji === emoji
          ? { ...group, count: group.count + 1, viewerHasReacted: true }
          : group,
      );
    });
  };

  const totalCount = () =>
    reactions().reduce((sum, group) => sum + group.count, 0);
  const inertControl =
    "inline-flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground";

  return (
    <article class="rounded-lg border bg-background p-4">
      <div class="flex items-center gap-3">
        <div class="size-10 rounded-full bg-muted" aria-hidden="true" />
        <div>
          <p class="text-sm font-medium">{props.name}</p>
          <p class="text-xs text-muted-foreground">{props.handle}</p>
        </div>
      </div>
      <p class="mt-3 text-sm leading-relaxed">{props.body}</p>
      {/* Static stand-ins for the other engagement controls; only the
          reaction control is interactive in this mockup. */}
      <div class="mt-2 -mx-2 flex items-center justify-between gap-1">
        <span class={inertControl}>
          <IconMessageSquare class="size-4" aria-hidden="true" />
          <span class="text-xs">2</span>
        </span>
        <span class={inertControl}>
          <IconRepeat2 class="size-4" aria-hidden="true" />
          <span class="text-xs">1 + 0</span>
        </span>
        <span class="inline-flex items-center">
          <QuickReactionBar
            reactions={reactions()}
            onToggleReaction={handleToggle}
            onOpenFullPicker={() => {}}
          />
          <span class="px-1 text-xs text-muted-foreground tabular-nums">
            {totalCount()}
          </span>
        </span>
        <span class={inertControl}>
          <IconBookmark class="size-4" aria-hidden="true" />
        </span>
        <span class={inertControl}>
          <IconEllipsis class="size-4" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}

/**
 * The bar in its intended habitat: the engagement row of timeline
 * notes.  Hover the heart on either note; each post keeps its own
 * reaction state.
 */
export const InTimelineContext: Story = {
  render: () => (
    <div class="mx-auto max-w-xl space-y-4 pt-20">
      <FakeTimelineNote
        name="Ailee"
        handle="@ailee@hackers.pub"
        body="Shipped hover-to-react on the timeline today. One less click for every reaction, and you can stack several emojis without reopening the picker."
        initialReactions={[
          { emoji: "❤️", count: 5, viewerHasReacted: true },
          { emoji: "🤔", count: 2, viewerHasReacted: false },
        ]}
      />
      <FakeTimelineNote
        name="Byeol"
        handle="@byeol@example.com"
        body="Does anyone else sort their emoji reactions by how hard the bug fought back? 😂 → 🤔 → 😢 in that order."
      />
    </div>
  ),
};

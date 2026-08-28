import {
  createOperationDescriptor,
  Environment,
  getRequest,
  graphql,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";
import { MockPayloadGenerator, type MockResolvers } from "relay-test-utils";
import { RelayEnvironmentProvider } from "solid-relay";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { NoteCard } from "./NoteCard.tsx";
import type { NoteCardStoriesQuery } from "./__generated__/NoteCardStoriesQuery.graphql.ts";
import type { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";

const NoteCardStoriesQuery = graphql`
  query NoteCardStoriesQuery($id: ID!, $actingAccountId: ID) {
    node(id: $id) {
      ... on Note {
        ...NoteCard_note @arguments(actingAccountId: $actingAccountId)
      }
    }
  }
`;

// A 1200×630 placeholder that mimics a typical Open Graph image, wide
// enough to exercise LinkPreview's "wide" layout branch.
function ogImageDataUri(label: string, background: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">` +
    `<rect width="1200" height="630" fill="${background}"/>` +
    `<text x="600" y="330" text-anchor="middle" font-family="sans-serif" ` +
    `font-size="64" font-weight="700" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface LinkPreviewArgs {
  url: string;
  title: string;
  description?: string | null;
  siteName?: string | null;
  imageLabel?: string | null;
}

// A single reusable `Actor` mock: every place the fragment tree reaches an
// actor (post author, organization member, action-menu ownership check)
// gets the same values, which keeps the payload below readable.
function mockResolvers(content: string, link?: LinkPreviewArgs): MockResolvers {
  return {
    Node: () => ({ __typename: "Note" }),
    PostLink: () => ({
      title: link?.title,
      description: link?.description ?? null,
      author: null,
      siteName: link?.siteName ?? null,
      // No LinkCreatorAttribution in these stories: null skips that
      // nested fragment's own field set entirely.
      creator: null,
      image:
        link?.imageLabel == null
          ? null
          : {
              url: ogImageDataUri(link.imageLabel, "#0e8a86"),
              width: 1200,
              height: 630,
              alt: link.imageLabel,
            },
    }),
    Actor: () => ({
      name: "Ellie Byrne",
      handle: "@ellie@hackers.pub",
      username: "ellie",
      local: true,
      // No image: exercises PostAvatar's real `AvatarFallback`, which
      // renders `avatarInitials` (the same path real actors without a
      // custom avatar take), instead of faking one with a hand-rolled SVG.
      avatarUrl: null,
      avatarInitials: "EB",
      url: "https://hackers.pub/@ellie",
      iri: "https://hackers.pub/ap/actors/ellie",
      isViewer: false,
      viewerMutes: false,
    }),
    Account: () => ({ id: "story-account", kind: "PERSONAL" }),
    Note: () => ({
      id: "story-note",
      uuid: "0198f2b1-89c1-7000-8000-000000000001",
      sourceId: null,
      viewerCanRevokeQuote: false,
      censored: false,
      content,
      language: "en",
      personalRawContent: null,
      rawContent: null,
      sensitive: false,
      summary: null,
      quotePolicy: "EVERYONE",
      visibility: "PUBLIC",
      quoteTargetState: null,
      quotedPost: null,
      organizationAuthor: null,
      media: [],
      linkPreviewUrl: link?.url ?? null,
      // Omitted (not set to `null`) when a link is present, so the
      // `PostLink` resolver above generates it; explicitly nulled to
      // suppress the preview otherwise.
      ...(link == null ? { link: null } : {}),
      published: "2026-08-20T09:30:00.000Z",
      url: "https://hackers.pub/@ellie/0198f2b1-89c1-7000-8000-000000000001",
      iri: "https://hackers.pub/ap/notes/0198f2b1-89c1-7000-8000-000000000001",
      engagementStats: {
        replies: 3,
        shares: 5,
        quotes: 1,
        reactions: 4,
        bookmarks: 2,
      },
      viewerHasShared: false,
      viewerCanReply: true,
      viewerCanQuote: true,
      viewerCanShare: true,
      viewerHasBookmarked: false,
      viewerHasPinned: false,
      reactionGroups: [],
      sharedPost: null,
    }),
  };
}

// No network is ever hit: the environment's store is seeded synchronously
// below via `commitPayload`, so `NoteCard` reads the fragment straight out
// of the store on first render.
function noteCardKey(
  content: string,
  link?: LinkPreviewArgs,
): {
  environment: Environment;
  note: NoteCard_note$key;
} {
  const environment = new Environment({
    network: Network.create(() => {
      throw new Error("Storybook's mock environment has no real network");
    }),
    store: new Store(new RecordSource()),
  });
  const operation = createOperationDescriptor(
    getRequest(NoteCardStoriesQuery),
    { id: "story-note", actingAccountId: null },
  );
  const payload = MockPayloadGenerator.generate(
    operation,
    mockResolvers(content, link),
  );
  if (payload.data == null) {
    throw new Error("MockPayloadGenerator produced no data");
  }
  environment.commitPayload(operation, payload.data);
  const data = environment.lookup(operation.fragment).data as unknown as {
    node: NoteCard_note$key;
  };
  return { environment, note: data.node };
}

interface NoteCardStoryArgs {
  /** Raw HTML for the mocked note's `content` field. */
  content: string;
  /** When set, the note also carries a link preview (see `LinkPreview`). */
  link?: LinkPreviewArgs;
}

const meta = {
  title: "Components/NoteCard",
  render: (args: NoteCardStoryArgs) => {
    const { environment, note } = noteCardKey(args.content, args.link);
    return (
      <RelayEnvironmentProvider environment={environment}>
        <div class="max-w-lg border-x">
          <NoteCard $note={note} />
        </div>
      </RelayEnvironmentProvider>
    );
  },
} satisfies Meta<NoteCardStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

const shortHtml =
  "<p>Just shipped a small fix for the timeline. Nothing dramatic, but it should make scrolling feel a bit smoother.</p>";

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

export const ShortNote: Story = {
  name: "Short note (no toggle)",
  args: { content: shortHtml },
};

export const LongNote: Story = {
  name: "Long note (collapsed)",
  args: { content: longHtml },
};

// The real backend only ever populates `link`/`linkPreviewUrl` by parsing
// the post's own rendered content for the first qualifying `<a href>`
// (`models/html.ts`'s `extractExternalLinks`, called from
// `models/post/source.ts` and `models/post/remote.ts`); it's never set
// independently of content. So this story's content actually contains the
// same URL as the mocked `link`, the way a real post would — and it's
// long enough to also exercise the collapse: `LinkPreview` renders after
// `ExpandableHtmlContent`, unclamped, so a collapsed note still shows its
// full-size link preview below the faded text.
const linkUrl = "https://example.blog/activitypub-federation-explained";
const longNoteWithLinkHtml = `
  <p>I've been meaning to write this down for a while: every time someone
  asks how ActivityPub federation actually works end to end, I end up
  re-explaining the same handful of moving parts from scratch.</p>
  <p>The short version is that your instance's outbox signs an activity
  and POSTs it to the target actor's inbox URL, the receiving instance
  verifies the HTTP signature against a key fetched from your actor
  document, and only then does it get queued for processing. Almost
  every subtle bug people hit lives somewhere in that handshake.</p>
  <p>I finally found a writeup that walks through the whole thing,
  inbox delivery included, without skipping the parts that usually trip
  people up. Linking it here so I stop re-typing this explanation:
  <a href="${linkUrl}">${linkUrl}</a></p>
`;

export const LongNoteWithLink: Story = {
  name: "Long note with a link preview (collapsed)",
  args: {
    content: longNoteWithLinkHtml,
    link: {
      url: linkUrl,
      title: "How ActivityPub Federation Actually Works",
      description:
        "A practical walkthrough of inbox delivery, actors, and the " +
        "parts of the spec that trip people up.",
      siteName: "example.blog",
      imageLabel: "ActivityPub",
    },
  },
};

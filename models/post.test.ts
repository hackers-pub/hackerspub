import {
  mockFetch,
  mockGlobalFetch,
  resetFetch,
  resetGlobalFetch,
} from "@c4spar/mock-fetch";
import {
  createFederation,
  type DocumentLoader,
  MemoryKvStore,
} from "@fedify/fedify";
import assert from "node:assert";
import test, { describe, it } from "node:test";
import { validate } from "@std/uuid/v7";
import { scrapePostLink } from "./link-preview.ts";
import { isArticleLike } from "./post/core.ts";
import { withDocumentLoaderTimeout } from "./post/remote.ts";
import { isPostVisibleTo } from "./post/visibility.ts";
import type { Actor, Instance, Post } from "./schema.ts";

const federation = createFederation<void>({
  kv: new MemoryKvStore(),
});
const ctx = federation.createContext(
  new URL("https://hackers.pub/"),
  undefined,
);

test("isArticleLike() does not treat named Questions as articles", () => {
  const post = {
    type: "Question",
    name: "Runtime choice",
    actor: {
      instance: { software: "hackerspub" } as Instance,
    } as Actor & { instance: Instance },
  } as Post & { actor: Actor & { instance: Instance } };

  assert.equal(isArticleLike(post), false);
});

test("scrapePostLink() scrapes Open Graph metadata", async () => {
  mockGlobalFetch();
  mockFetch("https://example.internal/index.html", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: `<html>
        <head>
          <meta property="og:type" content="website">
          <meta property="og:site_name" content="Example Site">
          <meta property="og:title" content="Example title">
          <meta property="og:description" content="Example og description">
          <meta property="og:url" content="https://example.internal/">
          <meta property="og:article:author" content="John Doe">
          <meta property="og:image" content="https://example.internal/image.jpg">
          <meta property="og:image:width" content="1200">
          <meta property="og:image:height" content="630">
          <meta property="og:image:type" content="image/jpeg">
          <meta name="fediverse:creator" content="@hongminhee@hollo.social">
        </head>
      </html>`,
  });
  const link = await scrapePostLink(
    ctx,
    "https://example.internal/index.html",
    (handle) =>
      Promise.resolve(
        handle === "@hongminhee@hollo.social"
          ? "00000000-0000-0000-0000-000000000000"
          : undefined,
      ),
  );
  assert.deepEqual(link, {
    id: link?.id ?? "00000000-0000-0000-0000-000000000000",
    url: "https://example.internal/index.html",
    title: "Example title",
    description: "Example og description",
    siteName: "Example Site",
    type: "website",
    author: "John Doe",
    imageUrl: "https://example.internal/image.jpg",
    imageWidth: 1200,
    imageHeight: 630,
    imageType: "image/jpeg",
    imageAlt: undefined,
    creatorId: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(link != null && validate(link.id));
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() keeps image URL when metadata probing fails", async () => {
  mockGlobalFetch();
  mockFetch("https://example.internal/no-dimensions.html", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: `<html>
        <head>
          <meta property="og:type" content="website">
          <meta property="og:site_name" content="Example Site">
          <meta property="og:title" content="No dimensions">
          <meta property="og:url" content="https://example.internal/no-dimensions">
          <meta property="og:image" content="https://example.internal/image-without-metadata.bin">
        </head>
      </html>`,
  });
  mockFetch("https://example.internal/image-without-metadata.bin", {
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: "not-an-image",
  });
  const link = await scrapePostLink(
    ctx,
    "https://example.internal/no-dimensions.html",
    () => Promise.resolve(undefined),
  );
  assert.deepEqual(link, {
    id: link?.id ?? "00000000-0000-0000-0000-000000000000",
    url: "https://example.internal/no-dimensions.html",
    title: "No dimensions",
    description: undefined,
    siteName: "Example Site",
    type: "website",
    author: undefined,
    imageUrl: "https://example.internal/image-without-metadata.bin",
    imageWidth: undefined,
    imageHeight: undefined,
    imageType: undefined,
    imageAlt: undefined,
    creatorId: undefined,
  });
  assert.ok(link != null && validate(link.id));
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() does not fetch unsafe preview images", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = input.toString();
    requestedUrls.push(url);
    if (url === "https://example.com/article") {
      return Promise.resolve(
        new Response(
          `<html><head>
          <meta property="og:title" content="Unsafe image">
          <meta property="og:image" content="http://127.0.0.1/private.png">
        </head></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const link = await scrapePostLink(
      ctx,
      "https://example.com/article",
      () => Promise.resolve(undefined),
    );

    assert.deepEqual(requestedUrls, ["https://example.com/article"]);
    assert.equal(link?.imageUrl, undefined);
    assert.equal(link?.imageWidth, undefined);
    assert.equal(link?.imageHeight, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scrapePostLink() rejects unsafe preview image redirects", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const redirectModes: (RequestRedirect | undefined)[] = [];
  globalThis.fetch = ((input, init) => {
    const url = input.toString();
    requestedUrls.push(url);
    redirectModes.push(init?.redirect);
    if (url === "https://example.com/article") {
      return Promise.resolve(
        new Response(
          `<html><head>
          <meta property="og:title" content="Redirected image">
          <meta property="og:image" content="https://images.example/preview.png">
        </head></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
      );
    }
    if (url === "https://images.example/preview.png") {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/private.png" },
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const link = await scrapePostLink(
      ctx,
      "https://example.com/article",
      () => Promise.resolve(undefined),
    );

    assert.deepEqual(requestedUrls, [
      "https://example.com/article",
      "https://images.example/preview.png",
    ]);
    assert.deepEqual(redirectModes, ["manual", "manual"]);
    assert.equal(link?.imageUrl, undefined);
    assert.equal(link?.imageWidth, undefined);
    assert.equal(link?.imageHeight, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scrapePostLink() ignores malformed canonical metadata", async () => {
  mockGlobalFetch();
  mockFetch("https://delta.chat/index.html", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: `<html>
        <head>
          <meta property="og:title" content="Delta Chat">
          <meta property="og:url" content="https://delta.chat{{ page.url }}">
        </head>
      </html>`,
  });

  const link = await scrapePostLink(
    ctx,
    "https://delta.chat/index.html",
    () => Promise.resolve(undefined),
  );

  assert.equal(link?.url, "https://delta.chat/index.html");
  assert.equal(link?.title, "Delta Chat");
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() ignores same-origin canonical metadata", async () => {
  mockGlobalFetch();
  mockFetch("https://www.youtube.com/watch?v=video", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: `<html>
        <head>
          <meta property="og:title" content="Example video">
          <meta property="og:url" content="https://www.youtube.com/undefined">
        </head>
      </html>`,
  });

  const link = await scrapePostLink(
    ctx,
    "https://www.youtube.com/watch?v=video",
    () => Promise.resolve(undefined),
  );

  assert.equal(link?.url, "https://www.youtube.com/watch?v=video");
  assert.equal(link?.title, "Example video");
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() uses the redirect-verified response URL", async () => {
  const originalFetch = globalThis.fetch;
  const response = new Response(
    `<html><head><meta property="og:title" content="Redirected"></head></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
  Object.defineProperty(response, "url", {
    value: "https://destination.example/article",
  });
  globalThis.fetch = () => Promise.resolve(response);
  try {
    const link = await scrapePostLink(
      ctx,
      "https://short.example/story",
      () => Promise.resolve(undefined),
    );

    assert.equal(link?.url, "https://destination.example/article");
    assert.equal(link?.title, "Redirected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scrapePostLink() ignores unsupported charsets", async () => {
  mockGlobalFetch();
  mockFetch("https://example.internal/legacy-charset.html", {
    headers: {
      "Content-Type": "text/html; charset=cp51932",
    },
    body: `<html>
        <head>
          <meta property="og:title" content="Legacy charset">
        </head>
      </html>`,
  });

  const link = await scrapePostLink(
    ctx,
    "https://example.internal/legacy-charset.html",
    () => Promise.resolve(undefined),
  );

  assert.equal(link, undefined);
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() drops non-HTTP image URL protocols", async () => {
  mockGlobalFetch();
  mockFetch("https://example.internal/relative-image.html", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: `<html>
        <head>
          <meta property="og:title" content="Relative image">
          <meta property="og:url" content="https://example.internal/relative-image">
          <meta property="og:image" content="git.ayo.run:3000/repo-avatars/image.jpg">
          <meta property="og:image:alt" content="Preview">
          <meta property="og:image:type" content="image/jpeg">
        </head>
      </html>`,
  });

  const link = await scrapePostLink(
    ctx,
    "https://example.internal/relative-image.html",
    () => Promise.resolve(undefined),
  );

  assert.deepEqual(link, {
    id: link?.id ?? "00000000-0000-0000-0000-000000000000",
    url: "https://example.internal/relative-image.html",
    title: "Relative image",
    description: undefined,
    siteName: undefined,
    type: undefined,
    author: undefined,
    imageUrl: undefined,
    imageWidth: undefined,
    imageHeight: undefined,
    imageType: undefined,
    imageAlt: undefined,
    creatorId: undefined,
  });
  assert.ok(link != null && validate(link.id));
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() treats an empty HTML response as no preview", async () => {
  mockGlobalFetch();
  mockFetch("https://example.internal/empty.html", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    body: "",
  });

  const link = await scrapePostLink(
    ctx,
    "https://example.internal/empty.html",
    () => Promise.resolve(undefined),
  );

  assert.equal(link, undefined);
  resetFetch();
  resetGlobalFetch();
});

test("scrapePostLink() passes caller abort signals to fetch", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = ((_input, init) => {
    calls++;
    assert.equal(init?.signal?.aborted, true);
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }) as typeof fetch;
  try {
    const link = await scrapePostLink(
      ctx,
      "https://example.internal/slow.html",
      () => Promise.resolve(undefined),
      { signal: controller.signal },
    );

    assert.equal(link, undefined);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("withDocumentLoaderTimeout()", () => {
  // Capture the signal the wrapped loader forwards to the underlying loader so
  // we can assert how the per-fetch timeout, caller signal, and overall
  // deadline are combined.
  const makeLoader = () => {
    let captured: AbortSignal | undefined;
    const loader: DocumentLoader = (url, options) => {
      captured = options?.signal ?? undefined;
      return Promise.resolve({
        contextUrl: null,
        document: {},
        documentUrl: url,
      });
    };
    return { loader, captured: () => captured };
  };

  it("forwards a live per-fetch timeout signal", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000)("https://example.com/");
    const signal = captured();
    assert.ok(signal != null);
    assert.deepEqual(signal.aborted, false);
  });

  it("propagates an already-aborted overall deadline", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000, AbortSignal.abort())(
      "https://example.com/",
    );
    const signal = captured();
    assert.ok(signal != null);
    assert.deepEqual(signal.aborted, true);
  });

  it("propagates an already-aborted caller signal", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000)("https://example.com/", {
      signal: AbortSignal.abort(),
    });
    const signal = captured();
    assert.ok(signal != null);
    assert.deepEqual(signal.aborted, true);
  });
});

describe("isPostVisibleTo()", () => {
  const HOUR = 60 * 60 * 1000;

  function fakeActor(
    overrides: Partial<Actor>,
  ): Actor & { followers: never[]; blockees: never[]; blockers: never[] } {
    return {
      id: crypto.randomUUID(),
      iri: `https://example.com/actors/${crypto.randomUUID()}`,
      accountId: null,
      suspended: null,
      suspendedUntil: null,
      ...overrides,
      followers: [],
      blockees: [],
      blockers: [],
    } as unknown as Actor & {
      followers: never[];
      blockees: never[];
      blockers: never[];
    };
  }

  it("hides boosts of sanction-hidden actors' posts", () => {
    // The boosted post's local author is banned; the booster is fine.
    const bannedAuthor = fakeActor({
      accountId: crypto.randomUUID() as Actor["accountId"],
      suspended: new Date(Date.now() - HOUR),
      suspendedUntil: null,
    });
    const booster = fakeActor({});
    const wrapper = {
      visibility: "public",
      actor: booster,
      mentions: [],
      sharedPost: { visibility: "public", actor: bannedAuthor },
    } as unknown as Parameters<typeof isPostVisibleTo>[0];
    // The wrapper denormalizes the banned author's content, so it is
    // hidden from guests and unrelated viewers:
    assert.equal(isPostVisibleTo(wrapper), false);
    assert.equal(isPostVisibleTo(wrapper, fakeActor({})), false);
    // The boosted post's author keeps access:
    assert.equal(isPostVisibleTo(wrapper, bannedAuthor), true);
    // The booster does NOT: the wrapper carries the hidden content.
    assert.equal(isPostVisibleTo(wrapper, booster), false);
    // An unsanctioned boosted author stays visible:
    const fineAuthor = fakeActor({});
    const fineWrapper = {
      visibility: "public",
      actor: booster,
      mentions: [],
      sharedPost: { visibility: "public", actor: fineAuthor },
    } as unknown as Parameters<typeof isPostVisibleTo>[0];
    assert.equal(isPostVisibleTo(fineWrapper), true);
  });
});

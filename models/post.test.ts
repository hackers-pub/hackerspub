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
import { scrapePostLink, withDocumentLoaderTimeout } from "./post.ts";

const federation = createFederation<void>({
  kv: new MemoryKvStore(),
});
const ctx = federation.createContext(
  new URL("https://hackers.pub/"),
  undefined,
);

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
    url: "https://example.internal/",
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
    url: "https://example.internal/no-dimensions",
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

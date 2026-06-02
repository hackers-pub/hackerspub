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
import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { validate } from "@std/uuid/v7";
import { scrapePostLink, withDocumentLoaderTimeout } from "./post.ts";

Deno.test("scrapePostLink()", async (t) => {
  mockGlobalFetch();

  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
  });
  const ctx = federation.createContext(
    new URL("https://hackers.pub/"),
    undefined,
  );

  await t.step("", async () => {
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
    assertEquals(link, {
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
    assert(link != null && validate(link.id));
    resetFetch();
  });

  await t.step("keeps image URL when metadata probing fails", async () => {
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
    assertEquals(link, {
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
    assert(link != null && validate(link.id));
    resetFetch();
  });

  resetGlobalFetch();
});

Deno.test("withDocumentLoaderTimeout()", async (t) => {
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

  await t.step("forwards a live per-fetch timeout signal", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000)("https://example.com/");
    const signal = captured();
    assert(signal != null);
    assertEquals(signal.aborted, false);
  });

  await t.step("propagates an already-aborted overall deadline", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000, AbortSignal.abort())(
      "https://example.com/",
    );
    const signal = captured();
    assert(signal != null);
    assertEquals(signal.aborted, true);
  });

  await t.step("propagates an already-aborted caller signal", async () => {
    const { loader, captured } = makeLoader();
    await withDocumentLoaderTimeout(loader, 10_000)("https://example.com/", {
      signal: AbortSignal.abort(),
    });
    const signal = captured();
    assert(signal != null);
    assertEquals(signal.aborted, true);
  });
});

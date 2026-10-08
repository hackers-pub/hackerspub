import assert from "node:assert";
import test from "node:test";
import sharp from "sharp";
import {
  fetchAccountLinkMetadata,
  getAvatarUrl,
  transformAvatar,
  updateAccountLinks,
  verifyAccountLink,
} from "./account.ts";
import {
  insertAccountWithActor,
  withMockFetch,
  withRollback,
} from "../test/postgres.ts";

test("getAvatarUrl() prefers stored avatars and falls back to gravatar defaults", async () => {
  const disk = {
    getUrl(key: string) {
      return Promise.resolve(`http://localhost/media/${key}`);
    },
  };

  const stored = await getAvatarUrl(
    disk as never,
    {
      avatarMedium: { key: "avatars/existing.webp" },
      emails: [],
    } as never,
  );
  assert.equal(stored, "http://localhost/media/avatars/existing.webp");

  const fallback = await getAvatarUrl(
    disk as never,
    {
      avatarMedium: null,
      emails: [],
    } as never,
  );
  assert.equal(fallback, "https://gravatar.com/avatar/?d=mp&s=128");
});

test("transformAvatar() crops rectangular images and preserves alpha via webp", async () => {
  const input = await sharp({
    create: {
      width: 200,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();

  const { buffer, format } = await transformAvatar(input);

  assert.equal(format, "webp");
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 100);
  assert.equal(metadata.height, 100);
  assert.equal(metadata.format, "webp");
});

test("verifyAccountLink() recognizes rel=me links pointing at the profile URL", async () => {
  await withMockFetch(
    async (_input, options) => {
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(
        `<html><head><link rel="me" href="https://hackers.pub/@alice"></head></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    },
    async () => {
      const verified = await verifyAccountLink(
        "https://example.com/profile",
        "https://hackers.pub/@alice",
      );
      assert.equal(verified, true);
    },
  );
});

test("updateAccountLinks() stores ordered links with metadata and verification", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "accountlinksowner",
      name: "Account Links Owner",
      email: "accountlinksowner@example.com",
    });

    await withMockFetch(
      async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return new Response(
          `<html><body><a rel="me" href="https://hackers.pub/@accountlinksowner">me</a>${url}</body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      },
      async () => {
        const links = await updateAccountLinks(
          tx,
          account.account.id,
          "https://hackers.pub/@accountlinksowner",
          [
            { name: "GitHub", url: "https://github.com/dahlia" },
            { name: "Codeberg", url: "https://codeberg.org/hongminhee" },
          ],
        );

        assert.equal(links.length, 2);
        assert.deepEqual(
          links.map((link) => ({
            index: link.index,
            name: link.name,
            icon: link.icon,
            handle: link.handle,
            verified: link.verified != null,
          })),
          [
            {
              index: 0,
              name: "GitHub",
              icon: "github",
              handle: "@dahlia",
              verified: true,
            },
            {
              index: 1,
              name: "Codeberg",
              icon: "codeberg",
              handle: "@hongminhee",
              verified: true,
            },
          ],
        );
      },
    );
  });
});

test("updateAccountLinks() keeps links whose verification fetch fails", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "unverifiedlinksowner",
      name: "Unverified Links Owner",
      email: "unverifiedlinksowner@example.com",
    });
    await withMockFetch(
      async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("Certificate hostname mismatch"), {
            code: "ERR_TLS_CERT_ALTNAME_INVALID",
          }),
        });
      },
      async () => {
        const links = await updateAccountLinks(
          tx,
          account.account.id,
          "https://hackers.pub/@unverifiedlinksowner",
          [
            { name: "Homepage", url: "https://example.com/profile" },
            { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Example" },
          ],
        );
        assert.equal(links.length, 2);
        assert.equal(links[0].url, "https://example.com/profile");
        assert.equal(links[0].verified, null);
        assert.equal(links[1].icon, "wikipedia");
        assert.equal(links[1].verified, null);
      },
    );
  });
});

test("fetchAccountLinkMetadata() preserves the Wikipedia icon on an invalid response", async () => {
  let signal: AbortSignal | null | undefined;
  await withMockFetch(
    async (_input, options) => {
      signal = options?.signal;
      return new Response("{", {
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      assert.deepEqual(
        await fetchAccountLinkMetadata("https://en.wikipedia.org/wiki/Example"),
        { icon: "wikipedia" },
      );
    },
  );
  assert.ok(signal instanceof AbortSignal);
});

for (const stalled of [false, true]) {
  test(
    `fetchAccountLinkMetadata() keeps ActivityPub links with ${stalled ? "stalled WebFinger" : "malformed actor handles"}`,
    { timeout: 2_000 },
    async (t) => {
      if (stalled) t.mock.timers.enable({ apis: ["setTimeout"] });
      const paths: string[] = [];
      await withMockFetch(
        async (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          paths.push(url.pathname);
          if (url.pathname === "/.well-known/nodeinfo") {
            return Response.json({
              links: [
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
                  href: "https://1.1.1.1/nodeinfo/2.1",
                },
              ],
            });
          }
          if (url.pathname === "/nodeinfo/2.1") {
            return Response.json({
              version: "2.1",
              software: { name: "mastodon", version: "4.4.0" },
              protocols: ["activitypub"],
              services: { inbound: [], outbound: [] },
              openRegistrations: false,
              usage: { users: { total: 1 }, localPosts: 0, localComments: 0 },
              metadata: {},
            });
          }
          if (url.pathname === "/profile") {
            return Response.json(
              {
                "@context": "https://www.w3.org/ns/activitystreams",
                id: "https://1.1.1.1/profile",
                type: "Person",
                preferredUsername: stalled ? "alice" : "bad@name",
                inbox: "https://1.1.1.1/inbox",
              },
              { headers: { "Content-Type": "application/activity+json" } },
            );
          }
          if (stalled && url.pathname === "/.well-known/webfinger") {
            queueMicrotask(() => t.mock.timers.tick(10_000));
            return await new Promise<Response>(() => {});
          }
          return new Response(null, { status: 404 });
        },
        async () => {
          assert.deepEqual(
            await fetchAccountLinkMetadata("https://1.1.1.1/profile"),
            { icon: "activitypub" },
          );
        },
      );
      assert.ok(paths.includes("/profile"));
    },
  );
}

test("verifyAccountLink() treats a failed response body as unverified", async () => {
  await withMockFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
      ),
    async () => {
      assert.equal(
        await verifyAccountLink(
          "https://example.com/profile",
          "https://hackers.pub/@alice",
        ),
        false,
      );
    },
  );
});

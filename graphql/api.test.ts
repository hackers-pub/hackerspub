import type { RuntimeResources } from "@hackerspub/runtime/resources";
import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import type { YogaServerInstance } from "graphql-yoga";
import { createGraphqlApiHandler, isFederationRequestPath } from "./api.ts";
import type { GraphqlApiHandlerOptions } from "./api.ts";
import { ProtocolAdmission } from "./protocol-admission.ts";
import { loadProtocolHttpConfig } from "@hackerspub/runtime/config";
import type { ServerContext, UserContext } from "./builder.ts";
import { createNodeHttpServer } from "./node-http.ts";

interface FederationFetchOptions {
  readonly onNotAcceptable?: (request: Request) => Promise<Response>;
}

interface HandlerFixture {
  readonly handler: ReturnType<typeof createGraphqlApiHandler>;
  readonly federationRequests: Request[];
  readonly federationOptions: FederationFetchOptions[];
  readonly yogaRequests: Request[];
}

const redirectAccountId = "0193d0f2-7d6a-7b8e-9a4c-2f1e6d5c4b3a";

function createFedifyContext(data: unknown): object {
  const context = {
    data,
    parseUri(url: URL) {
      const match = /^\/ap\/actors\/([^/]+)$/.exec(url.pathname);
      return match == null ? null : { type: "actor", identifier: match[1] };
    },
    origin: "http://internal.example",
    canonicalOrigin: "http://internal.example",
    host: "internal.example",
    documentLoader: async () => null,
    contextLoader: async () => null,
    clone() {
      return context;
    },
    getActorUri: () => new URL("http://internal.example/ap/actors/alice"),
    getInboxUri: () => new URL("http://internal.example/ap/actors/alice/inbox"),
    getOutboxUri: () =>
      new URL("http://internal.example/ap/actors/alice/outbox"),
    getFollowersUri: () =>
      new URL("http://internal.example/ap/actors/alice/followers"),
    getFollowingUri: () =>
      new URL("http://internal.example/ap/actors/alice/following"),
    getFeaturedUri: () =>
      new URL("http://internal.example/ap/actors/alice/featured"),
    getObjectUri: () => new URL("http://internal.example/ap/posts/1"),
    getDocumentLoader() {
      return context.documentLoader;
    },
    lookupObject: async () => null,
    lookupWebFinger: async () => null,
    sendActivity: async () => {},
  };
  return context;
}

function createFixture(
  behindProxy = false,
  options: Partial<GraphqlApiHandlerOptions> = {},
): HandlerFixture {
  const federationRequests: Request[] = [];
  const federationOptions: FederationFetchOptions[] = [];
  const yogaRequests: Request[] = [];
  const disk = {};
  const resources = {
    config: {
      behindProxy,
      email: { from: "noreply@example.com" },
    },
    db: {
      query: {
        actorTable: {
          findFirst: async (query: { where: { accountId: string } }) =>
            query.where.accountId === redirectAccountId
              ? { url: "http://internal.example/@alice" }
              : undefined,
        },
      },
    },
    drive: {
      fileSystemRoot: undefined,
      use: () => disk,
    },
    email: {},
    federation: {
      fetch: async (request: Request, options: FederationFetchOptions) => {
        federationRequests.push(request);
        federationOptions.push(options);
        // Like Fedify, hand requests that only accept HTML to the fallback.
        if (
          request.headers.get("Accept") === "text/html" &&
          options.onNotAcceptable != null
        ) {
          return await options.onNotAcceptable(request);
        }
        return new Response("federation");
      },
      createContext: (_request: Request, data: unknown) =>
        createFedifyContext(data),
    },
    kv: {},
    models: {
      altTextGenerator: {},
      summarizer: {},
      translator: {},
      moderationAnalyzer: {},
    },
  } as unknown as RuntimeResources;
  const yogaServer = {
    fetch: async (request: Request) => {
      yogaRequests.push(request);
      return new Response("graphql");
    },
  } as unknown as YogaServerInstance<ServerContext, UserContext>;
  return {
    federationRequests,
    federationOptions,
    yogaRequests,
    handler: createGraphqlApiHandler({
      resources,
      yogaServer,
      assetlinksJson:
        '[{"relation":["delegate_permission/common.handle_all_urls"]}]',
      appleAppSiteAssociationJson: '{"applinks":{"details":[]}}',
      ...options,
    }),
  };
}

const connectionInfo = {
  remoteAddr: {
    transport: "tcp",
    hostname: "172.18.0.2",
    port: 43210,
  },
};

test("isFederationRequestPath covers every Fedify route family", () => {
  for (const pathname of [
    "/.well-known/webfinger",
    "/.well-known/nodeinfo",
    "/nodeinfo/2.1",
    "/ap/actors/alice/inbox",
    "/ap/actors/alice/outbox",
    "/ap/posts/1",
  ]) {
    assert.equal(isFederationRequestPath(pathname), true, pathname);
  }
  assert.equal(isFederationRequestPath("/graphql"), false);
  assert.equal(isFederationRequestPath("/media/image.png"), false);
  assert.equal(isFederationRequestPath("/.well-known/assetlinks.json"), false);
  assert.equal(
    isFederationRequestPath("/.well-known/apple-app-site-association"),
    false,
  );
  assert.equal(isFederationRequestPath("/.well-known/apgateway/example"), true);
});

test("the runtime-neutral handler serves application association files", async () => {
  const { federationRequests, handler, yogaRequests } = createFixture();
  const assetlinks = await handler(
    new Request("http://internal.example/.well-known/assetlinks.json"),
    connectionInfo,
  );
  const apple = await handler(
    new Request(
      "http://internal.example/.well-known/apple-app-site-association",
    ),
    connectionInfo,
  );

  assert.equal(assetlinks.status, 200);
  assert.equal(assetlinks.headers.get("content-type"), "application/json");
  assert.match(await assetlinks.text(), /delegate_permission/);
  assert.equal(apple.status, 200);
  assert.equal(apple.headers.get("content-type"), "application/json");
  assert.deepEqual(federationRequests, []);
  assert.deepEqual(yogaRequests, []);
});

test("the runtime-neutral handler delegates federation and GraphQL routes", async () => {
  const { federationRequests, handler, yogaRequests } = createFixture();
  for (const pathname of [
    "/.well-known/webfinger?resource=acct:alice@example.com",
    "/.well-known/nodeinfo",
    "/nodeinfo/2.1",
    "/ap/actors/alice/inbox",
    "/ap/actors/alice/outbox",
    "/ap/posts/1",
  ]) {
    const response = await handler(
      new Request(`http://internal.example${pathname}`),
      connectionInfo,
    );
    assert.equal(await response.text(), "federation");
  }
  const graphql = await handler(
    new Request("http://internal.example/graphql"),
    connectionInfo,
  );

  assert.equal(await graphql.text(), "graphql");
  assert.equal(federationRequests.length, 6);
  assert.equal(yogaRequests.length, 1);
});

test("federation requests get the HTML redirect fallback", async () => {
  const { federationOptions, handler } = createFixture();
  const redirect = await handler(
    new Request(`http://internal.example/ap/actors/${redirectAccountId}`, {
      headers: { Accept: "text/html" },
    }),
    connectionInfo,
  );
  assert.equal(redirect.status, 303);
  assert.equal(
    redirect.headers.get("Location"),
    "http://internal.example/@alice",
  );

  await handler(
    new Request("http://internal.example/ap/notes/1"),
    connectionInfo,
  );
  const onNotAcceptable = federationOptions[1]?.onNotAcceptable;
  assert.ok(onNotAcceptable != null);
  const response = await onNotAcceptable(
    new Request("http://internal.example/ap/notes/1", {
      headers: { Accept: "image/png" },
    }),
  );
  assert.equal(response.status, 406);
});

test("trusted forwarding is applied before federation dispatch", async () => {
  const { federationRequests, handler } = createFixture(true);
  await handler(
    new Request("http://internal.example/.well-known/webfinger", {
      headers: {
        "x-forwarded-for": "203.0.113.4",
        "x-forwarded-host": "public.example",
        "x-forwarded-proto": "https",
      },
    }),
    connectionInfo,
  );

  assert.equal(
    federationRequests[0]?.url,
    "https://public.example/.well-known/webfinger",
  );
});

test("aborted request work maps to status 499", async () => {
  const resources = {
    config: {
      behindProxy: false,
      email: { from: "noreply@example.com" },
    },
    db: {},
    drive: { fileSystemRoot: undefined, use: () => ({}) },
    email: {},
    federation: {
      fetch: async () => {
        throw new DOMException("The client disconnected.", "AbortError");
      },
    },
    kv: {},
    models: {},
  } as unknown as RuntimeResources;
  const handler = createGraphqlApiHandler({
    resources,
    yogaServer: {} as YogaServerInstance<ServerContext, UserContext>,
    assetlinksJson: "[]",
    appleAppSiteAssociationJson: "{}",
  });

  const response = await handler(
    new Request("http://internal.example/ap/actors/alice"),
    connectionInfo,
  );
  assert.equal(response.status, 499);
});

test("split roles reject opposite ownership before forwarding or body reads", async () => {
  const admission = new ProtocolAdmission(loadProtocolHttpConfig({}));
  const protocol = createFixture(true, {
    role: "protocol",
    protocolAdmission: admission,
    yogaServer: undefined,
  });
  const interactive = createFixture(true, { role: "interactive" });
  for (const [fixture, path] of [
    [interactive, "/ap/inbox"],
    [interactive, "/.well-known/webfinger"],
    [interactive, "/nodeinfo/2.1"],
    [protocol, "/graphql"],
    [protocol, "/medium-uploads/test"],
    [protocol, "/media/test"],
    [protocol, "/.well-known/assetlinks.json"],
    [protocol, "/.well-known/apple-app-site-association"],
  ] as const) {
    let pulled = false;
    const request = new Request(`http://internal.example${path}`, {
      method: "POST",
      body: new ReadableStream(
        {
          pull() {
            pulled = true;
            throw Error("must not read");
          },
        },
        { highWaterMark: 0 },
      ),
      // Node requires this only for a streaming body.
      ...({ duplex: "half" } as RequestInit),
    });
    assert.equal(
      (await fixture.handler(request, connectionInfo)).status,
      404,
      path,
    );
    assert.equal(pulled, false, path);
    assert.equal(fixture.federationRequests.length, 0);
    assert.equal(fixture.yogaRequests.length, 0);
  }
  for (const path of [
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
  ]) {
    assert.equal(
      (
        await interactive.handler(
          new Request(`http://internal.example${path}`),
          connectionInfo,
        )
      ).status,
      200,
    );
  }
  for (const path of [
    "/.well-known/nodeinfo",
    "/.well-known/apgateway/x",
    "/ap/actors/alice",
    "/nodeinfo/2.1",
  ]) {
    assert.equal(
      (
        await protocol.handler(
          new Request(`http://internal.example${path}`),
          connectionInfo,
        )
      ).status,
      200,
    );
  }
});

test("protocol readiness stays healthy at capacity and is independent of interactive readiness", async () => {
  const admission = new ProtocolAdmission({
    ...loadProtocolHttpConfig({}),
    limit: 1,
  });
  const protocol = createFixture(false, {
    role: "protocol",
    protocolAdmission: admission,
    yogaServer: undefined,
  });
  const interactive = createFixture(false, { role: "interactive" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const occupied = admission.run(
    new Request("http://internal.example/ap/inbox"),
    async () => {
      entered.resolve();
      await release.promise;
      return new Response("ok");
    },
  );
  await entered.promise;
  const probe = () =>
    protocol.handler(
      new Request("http://internal.example/health"),
      connectionInfo,
    );
  assert.deepEqual(await (await probe()).json(), {
    ready: true,
    role: "protocol",
  });
  admission.stop();
  assert.equal((await probe()).status, 503);
  assert.equal(
    (
      await interactive.handler(
        new Request("http://internal.example/health"),
        connectionInfo,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await interactive.handler(
        new Request("http://internal.example/graphql"),
        connectionInfo,
      )
    ).status,
    200,
  );
  release.resolve();
  await occupied;
  await admission.idle();
});

test(
  "health only accepts GET/HEAD and closes unfinished raw HTTP bodies",
  { timeout: 5000 },
  async (t) => {
    const admission = new ProtocolAdmission(loadProtocolHttpConfig({}));
    const fixture = createFixture(false, {
      role: "protocol",
      protocolAdmission: admission,
    });
    const server = createNodeHttpServer(fixture.handler);
    const address = await server.listen({ hostname: "127.0.0.1", port: 0 });
    t.after(() => server.close());
    for (const method of ["POST", "GET", "HEAD"]) {
      const socket = connect({ host: "127.0.0.1", port: address.port });
      t.after(() => socket.destroy());
      const closed = Promise.withResolvers<void>();
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (data) => {
        reply += data;
      });
      socket.on("error", closed.reject);
      socket.on("close", () => closed.resolve());
      socket.write(
        `${method} /health HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n`,
      );
      await closed.promise;
      assert.match(
        reply,
        new RegExp(`^HTTP/1.1 ${method === "POST" ? 405 : 200}`),
      );
      assert.match(reply, /connection: close/i);
      if (method === "POST") assert.match(reply, /allow: GET, HEAD/i);
    }
    assert.equal(admission.stats.admitted, 0);
    assert.equal(fixture.federationRequests.length, 0);
    assert.equal(fixture.yogaRequests.length, 0);
  },
);

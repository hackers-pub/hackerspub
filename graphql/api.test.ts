import type { RuntimeResources } from "@hackerspub/runtime/resources";
import assert from "node:assert/strict";
import test from "node:test";
import type { YogaServerInstance } from "graphql-yoga";
import { createGraphqlApiHandler, isFederationRequestPath } from "./api.ts";
import type { ServerContext, UserContext } from "./builder.ts";

interface HandlerFixture {
  readonly handler: ReturnType<typeof createGraphqlApiHandler>;
  readonly federationRequests: Request[];
  readonly yogaRequests: Request[];
}

function createFedifyContext(data: unknown): object {
  const context = {
    data,
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

function createFixture(behindProxy = false): HandlerFixture {
  const federationRequests: Request[] = [];
  const yogaRequests: Request[] = [];
  const disk = {};
  const resources = {
    config: {
      behindProxy,
      email: { from: "noreply@example.com" },
    },
    db: {},
    drive: {
      fileSystemRoot: undefined,
      use: () => disk,
    },
    email: {},
    federation: {
      fetch: async (request: Request) => {
        federationRequests.push(request);
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
    yogaRequests,
    handler: createGraphqlApiHandler({
      resources,
      yogaServer,
      assetlinksJson:
        '[{"relation":["delegate_permission/common.handle_all_urls"]}]',
      appleAppSiteAssociationJson: '{"applinks":{"details":[]}}',
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

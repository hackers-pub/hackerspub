import {
  createFederation,
  type InboxContext,
  MemoryKvStore,
} from "@fedify/fedify";
import {
  Accept,
  type Activity,
  Note,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
} from "@fedify/vocab";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContextData } from "@hackerspub/models/context";
import {
  evaluateQuotePolicy,
  type QuotePolicyPost,
} from "@hackerspub/models/post/visibility";
import type { Actor, QuotePolicy } from "@hackerspub/models/schema";
import { toApplicationContext } from "./context.ts";
import { onQuoteRequested } from "./inbox/quote.ts";
import { federationServices } from "./services.ts";

function createContext() {
  const federation = createFederation<ContextData>({ kv: new MemoryKvStore() });
  return toApplicationContext(
    federation.createContext(new URL("https://local.example"), {
      services: { federation: federationServices },
    } as unknown as ContextData),
  );
}

test("quote policy uses DB followers and preserves visibility and self approval", async () => {
  const ctx = createContext();
  const author = {
    id: "author",
    iri: "https://local.example/author",
    followersUrl: "https://local.example/author/followers",
    followers: [],
    blockees: [],
    blockers: [],
  } as unknown as QuotePolicyPost["actor"];
  const requester = {
    id: "requester",
    iri: "https://remote.example/requester",
  } as unknown as Actor;
  const post = {
    actor: author,
    actorId: author.id,
    sharedPostId: null,
    visibility: "public",
    mentions: [],
    quotePolicy: "followers",
    quoteRequestPolicy: "everyone",
  } as unknown as QuotePolicyPost;
  for (const policy of ["everyone", "followers", "self"] as QuotePolicy[]) {
    post.quotePolicy = policy;
    for (const accepted of [null, new Date()]) {
      author.followers = [
        { followerId: requester.id, accepted },
      ] as QuotePolicyPost["actor"]["followers"];
      assert.equal(
        await evaluateQuotePolicy(ctx, post, requester),
        policy === "everyone" || (policy === "followers" && accepted != null)
          ? "automatic"
          : "manual",
      );
      assert.equal(await evaluateQuotePolicy(ctx, post, author), "automatic");
    }
  }
  author.followersUrl = null;
  post.quotePolicy = "followers";
  assert.equal(await evaluateQuotePolicy(ctx, post, requester), "automatic");
  post.quotePolicy = "self";
  post.quoteRequestPolicy = null;
  assert.equal(await evaluateQuotePolicy(ctx, post, requester), "denied");
  post.quotePolicy = "everyone";
  author.blockees = [
    { blockeeId: requester.id },
  ] as QuotePolicyPost["actor"]["blockees"];
  assert.equal(await evaluateQuotePolicy(ctx, post, requester), "denied");
  author.blockees = [];
  for (const visibility of ["direct", "none"] as const) {
    post.visibility = visibility;
    assert.equal(await evaluateQuotePolicy(ctx, post, author), "denied");
  }
});

test("remote authorization helper verifies fetched ID, origin and quote binding", async () => {
  const ctx = createContext();
  const id = new URL("https://author.example/authorization");
  const author = new URL("https://author.example/actor");
  const quote = new URL("https://quoter.example/quote");
  const target = new URL("https://author.example/post");
  for (const variant of [
    "valid",
    "idless",
    "alias",
    "other ID",
    "wrong quote",
    "wrong target",
    "wrong author",
  ]) {
    const authorization = new QuoteAuthorization({
      id:
        variant === "idless"
          ? null
          : variant === "alias"
            ? new URL("https://alias.example/authorization")
            : variant === "other ID"
              ? new URL("https://author.example/other")
              : id,
      attribution:
        variant === "wrong author"
          ? new URL("https://author.example/other-actor")
          : author,
      interactingObject: variant === "wrong quote" ? target : quote,
      interactionTarget: variant === "wrong target" ? quote : target,
    });
    const document = await authorization.toJsonLd();
    const fetched: string[] = [];
    assert.equal(
      await federationServices.verifyQuoteAuthorization(
        ctx,
        id,
        quote,
        target,
        author,
        async (url) => {
          fetched.push(url);
          return {
            document,
            documentUrl: authorization.id?.href ?? id.href,
            contextUrl: null,
          };
        },
        ctx.contextLoader,
      ),
      variant === "valid",
      variant,
    );
    assert.deepEqual(fetched, [id.href]);
  }
});

test("quote handler verifies compatible instruments without fetching local targets", async () => {
  for (const variant of [
    "quoteUrl",
    "conflicting quote",
    "multiple authors",
    "redirected instrument",
    "wrong target",
    "wrong author",
    "cross-origin instrument",
  ]) {
    const requester = {
      id: "requester",
      iri: "https://remote.example/actor",
      inboxUrl: "https://remote.example/inbox",
      accountId: null,
    };
    const target = {
      id: "target",
      iri: "https://local.example/post",
      sharedPostId: null,
      actorId: "author",
      actor: {
        id: "author",
        iri: "https://local.example/author",
        accountId: "account",
        followersUrl: "https://local.example/author/followers",
        followers: [],
        blockees: [],
        blockers: [],
      },
      visibility: "public",
      mentions: [],
      quotePolicy: "everyone",
      quoteRequestPolicy: null,
    };
    const activities: Activity[] = [];
    const issued: unknown[] = [];
    const db = {
      query: {
        actorTable: { findFirst: async () => requester },
        postTable: { findFirst: async () => target },
        quoteAuthorizationTable: {
          findFirst: async (options: { where: { quotePostIri: string } }) =>
            variant === "redirected instrument" &&
            options.where.quotePostIri === "https://remote.example/alias"
              ? {
                  id: "existing",
                  iri: "https://local.example/existing-authorization",
                }
              : undefined,
        },
      },
      insert: () => ({
        values: (row: unknown) => {
          issued.push(row);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    };
    const raw = createFederation<ContextData>({
      kv: new MemoryKvStore(),
    }).createContext(new URL("https://local.example"), {
      db,
      services: { federation: federationServices },
    } as unknown as ContextData);
    Object.assign(raw, {
      getObjectUri: () => new URL("https://local.example/authorization"),
      sendActivity: async (
        _sender: unknown,
        _recipients: unknown,
        activity: Activity,
      ) => {
        activities.push(activity);
      },
      documentLoader: async () => {
        throw new Error("Unexpected fetch");
      },
    });
    const other = new URL("https://remote.example/other");
    const instrument = new Note({
      id: new URL(
        variant === "cross-origin instrument"
          ? "https://evil.example/quote"
          : "https://remote.example/quote",
      ),
      attributions:
        variant === "multiple authors"
          ? [other, new URL(requester.iri)]
          : [variant === "wrong author" ? other : new URL(requester.iri)],
      quote:
        variant === "quoteUrl"
          ? null
          : variant === "conflicting quote" || variant === "wrong target"
            ? other
            : new URL(target.iri),
      quoteUrl: variant === "wrong target" ? other : new URL(target.iri),
    });
    if (variant === "redirected instrument") {
      Object.assign(raw, {
        documentLoader: async (url: string) => {
          assert.equal(url, "https://remote.example/alias");
          return {
            document: await instrument.toJsonLd(),
            documentUrl: instrument.id!.href,
            contextUrl: null,
          };
        },
      });
    }
    await onQuoteRequested(
      raw as unknown as InboxContext<ContextData>,
      new QuoteRequest({
        id: new URL("https://remote.example/request"),
        actor: new URL(requester.iri),
        object: new URL(target.iri),
        instrument:
          variant === "redirected instrument"
            ? new URL("https://remote.example/alias")
            : instrument,
      }),
    );
    const allowed = [
      "quoteUrl",
      "conflicting quote",
      "multiple authors",
      "redirected instrument",
    ].includes(variant);
    assert.equal(activities.length, 1, variant);
    assert.ok(activities[0] instanceof (allowed ? Accept : Reject), variant);
    assert.equal(issued.length, allowed ? 1 : 0, variant);
    if (variant === "redirected instrument") {
      assert.ok(activities[0] instanceof Accept);
      assert.equal(
        activities[0].resultId?.href,
        "https://local.example/existing-authorization",
      );
    }
  }
});

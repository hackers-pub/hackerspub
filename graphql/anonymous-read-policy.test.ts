import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, print } from "graphql";
import { isCheapGuestQuery, publicReadKey } from "./anonymous-read-policy.ts";
import { publicReadDocuments } from "./public-read-documents.ts";

const guest = { session: undefined, account: undefined };
const request = new Request("https://hackers.pub/graphql");
const document = parse(publicReadDocuments[0]);

test("approved complete news operations match current generated Relay text", async () => {
  for (const [index, name] of ["newsPageQuery", "NewsListQuery"].entries()) {
    const source = await readFile(
      new URL(
        `../web-next/src/__generated__/${name}.graphql.ts`,
        import.meta.url,
      ),
      "utf8",
    );
    const match = /"text":\s*("(?:\\.|[^"\\])*")/.exec(source);
    assert.ok(match, `missing operation text: ${name}`);
    assert.equal(
      print(parse(JSON.parse(match[1]))),
      print(parse(publicReadDocuments[index])),
    );
    assert.ok(
      publicReadKey(parse(publicReadDocuments[index]), undefined, {}, request),
    );
  }
});

test("cheap guests use actual root identities through aliases and fragments", () => {
  assert.equal(
    isCheapGuestQuery(
      parse(
        `query A { ...F } fragment F on Query { other: viewer { id moderator } webPushVapidPublicKey suggestedFilterLanguages __typename }`,
      ),
      "A",
      guest,
    ),
    true,
  );
  assert.equal(
    isCheapGuestQuery(
      parse("{ viewer { id } publicTimeline { edges { cursor } } }"),
      undefined,
      guest,
    ),
    false,
  );
  assert.equal(
    isCheapGuestQuery(
      parse("query A {viewer {id}} query B {publicTimeline {edges {cursor}}}"),
      "B",
      guest,
    ),
    false,
  );
  assert.equal(
    isCheapGuestQuery(
      parse("query A {viewer {id}} query B {publicTimeline {edges {cursor}}}"),
      "A",
      guest,
    ),
    true,
  );
  assert.equal(
    isCheapGuestQuery(parse("mutation { __typename }"), undefined, guest),
    false,
  );
  assert.equal(
    isCheapGuestQuery(
      parse("{ __schema { types { name } } }"),
      undefined,
      guest,
    ),
    false,
  );
});

test("sharing keys isolate all variables, locale, cursor and execution policy", () => {
  const key = publicReadKey(
    document,
    undefined,
    { order: "NEWEST", cursor: "a" },
    request,
  );
  assert.ok(key);
  assert.equal(
    publicReadKey(
      document,
      undefined,
      { cursor: "a", order: "NEWEST" },
      request,
    ),
    key,
  );
  assert.notEqual(
    publicReadKey(
      document,
      undefined,
      { order: "NEWEST", cursor: "b" },
      request,
    ),
    key,
  );
  assert.notEqual(
    publicReadKey(
      document,
      undefined,
      { order: "POPULAR", cursor: "a" },
      request,
    ),
    key,
  );
  for (const headers of [
    { "accept-language": "ko" },
    { "x-no-propagate": "true" },
  ] as HeadersInit[]) {
    assert.notEqual(
      publicReadKey(
        document,
        undefined,
        { order: "NEWEST", cursor: "a" },
        new Request(request, { headers }),
      ),
      key,
    );
  }
  assert.notEqual(
    publicReadKey(
      document,
      undefined,
      { order: "NEWEST", cursor: "a" },
      new Request("https://hackers.pub/graphql?no-propagate=true"),
    ),
    key,
  );
});

test("private, modified, unknown and oversized requests never share", () => {
  for (const headers of [
    { authorization: "Bearer invalid" },
    { cookie: "session=expired" },
  ] as HeadersInit[]) {
    assert.equal(
      publicReadKey(document, undefined, {}, new Request(request, { headers })),
      undefined,
    );
  }
  assert.equal(
    publicReadKey(
      parse(publicReadDocuments[0].replace("penalty", "score")),
      undefined,
      {},
      request,
    ),
    undefined,
  );
  assert.equal(
    publicReadKey(parse("mutation M { __typename }"), undefined, {}, request),
    undefined,
  );
  assert.equal(
    publicReadKey(parse("{ viewer { id } }"), undefined, {}, request),
    undefined,
  );
  assert.equal(
    publicReadKey(document, undefined, { value: "x".repeat(16_385) }, request),
    undefined,
  );
});

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  findActivityPubAlternate,
  negotiateActivityPubAlternate,
  prefersActivityPub,
} from "./activityPubNegotiation.ts";

test("prefersActivityPub() selects an explicitly preferred JSON representation", () => {
  for (const accept of [
    "application/activity+json",
    "application/activity+json, text/html",
    "application/activity+json, */*",
    "application/activity+json; q=0.9, */*; q=0.8",
    "application/activity+json; q=0.9, text/html; q=0.8",
  ]) {
    assert.equal(
      prefersActivityPub(accept, "application/activity+json"),
      true,
      accept,
    );
  }

  assert.equal(
    prefersActivityPub(
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    ),
    true,
  );
  assert.equal(
    prefersActivityPub(
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      "application/activity+json",
    ),
    true,
  );
  assert.equal(
    prefersActivityPub(
      "application/activity+json",
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    ),
    true,
  );
});

test("prefersActivityPub() leaves ordinary and HTML-preferred requests alone", () => {
  for (const accept of [
    null,
    "",
    "*/*",
    "application/*",
    "application/json",
    "application/activity+json; q=0",
    "application/activity+json; q=0.5, text/html; q=0.8",
    "application/activity+json; q=0.8, */*",
    "text/html, application/activity+json",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ]) {
    assert.equal(
      prefersActivityPub(accept, "application/activity+json"),
      false,
      String(accept),
    );
  }
});

test("prefersActivityPub() honors rejection of the advertised representation", () => {
  for (const [accept, advertisedMediaType] of [
    [
      "application/activity+json;q=0, application/json;q=1, text/html;q=0.5",
      "application/activity+json",
    ],
    [
      "application/activity+json;q=0, application/ld+json;q=1, " +
        "text/html;q=0.5",
      "application/activity+json",
    ],
    [
      "application/activity+json;q=0.4, application/ld+json;q=1, " +
        "text/html;q=0.5",
      "application/activity+json",
    ],
    [
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams";' +
        "q=0, application/activity+json;q=1, text/html;q=0.5",
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    ],
  ]) {
    assert.equal(
      prefersActivityPub(accept, advertisedMediaType),
      false,
      accept,
    );
  }
});

test("prefersActivityPub() matches media type parameters", () => {
  assert.equal(
    prefersActivityPub(
      "text/html;level=1;q=0.1, text/html;q=0.9, " +
        "application/activity+json;q=0.5",
      "application/activity+json",
    ),
    false,
  );
  assert.equal(
    prefersActivityPub(
      'application/ld+json; profile="https://example.com/other";q=1, ' +
        "application/ld+json;q=0.4, text/html;q=0.5",
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    ),
    false,
  );
});

test("findActivityPubAlternate() resolves an ActivityPub alternate", () => {
  assert.equal(
    findActivityPubAlternate(
      '<https://example.com/feed>; rel="alternate"; type="application/atom+xml", ' +
        '</ap/articles/1>; rel="alternate self"; ' +
        'type="application/ld+json; profile=\\"https://www.w3.org/ns/activitystreams\\""',
      "https://example.com/articles/1",
    )?.url.href,
    "https://example.com/ap/articles/1",
  );
  assert.equal(
    findActivityPubAlternate(
      '</ap/articles/1>; rel="alternate"; ' +
        'type="application/ld+json; profile=\\"https://www.w3.org/ns/activitystreams\\""',
      "https://example.com/articles/1",
    )?.mediaType,
    'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  );
});

test("findActivityPubAlternate() ignores unrelated and unsafe links", () => {
  assert.equal(
    findActivityPubAlternate(
      '<https://example.com/feed>; rel="alternate"; type="application/atom+xml", ' +
        '<javascript:alert(1)>; rel="alternate"; type="application/activity+json"',
      "https://example.com/articles/1",
    ),
    null,
  );
});

test("negotiateActivityPubAlternate() redirects ActivityPub requests", () => {
  const responseHeaders = new Headers({
    Link: '</ap/articles/1>; rel="alternate"; type="application/activity+json"',
    Vary: "Accept-Encoding",
  });
  responseHeaders.append("Set-Cookie", "flash=; Max-Age=0; Path=/");
  responseHeaders.append("Set-Cookie", "session=updated; HttpOnly; Path=/");
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/2026/article", {
      headers: { Accept: "application/activity+json" },
    }),
    responseHeaders,
  );

  assert.equal(response?.status, 307);
  assert.equal(
    response?.headers.get("Location"),
    "https://example.com/ap/articles/1",
  );
  assert.equal(response?.headers.get("Vary"), "Accept-Encoding, Accept");
  assert.deepEqual(response?.headers.getSetCookie(), [
    "flash=; Max-Age=0; Path=/",
    "session=updated; HttpOnly; Path=/",
  ]);
  assert.equal(responseHeaders.get("Vary"), "Accept-Encoding, Accept");
});

test("negotiateActivityPubAlternate() redirects HEAD requests", () => {
  const responseHeaders = new Headers({
    Link: '</ap/notes/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      method: "HEAD",
      headers: { Accept: "application/activity+json" },
    }),
    responseHeaders,
  );

  assert.equal(response?.status, 307);
  assert.equal(
    response?.headers.get("Location"),
    "https://example.com/ap/notes/1",
  );
});

test("negotiateActivityPubAlternate() avoids self redirects", () => {
  const responseHeaders = new Headers({
    Link: '</@alice/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      headers: { Accept: "application/activity+json" },
    }),
    responseHeaders,
  );

  assert.equal(response, undefined);
  assert.equal(responseHeaders.get("Vary"), "Accept");
});

test("negotiateActivityPubAlternate() keeps HTML while varying on Accept", () => {
  const responseHeaders = new Headers({
    Link: '</ap/notes/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      headers: { Accept: "text/html" },
    }),
    responseHeaders,
  );

  assert.equal(response, undefined);
  assert.equal(responseHeaders.get("Vary"), "Accept");
});

test("negotiateActivityPubAlternate() redirects JSON-LD ActivityPub requests", () => {
  const responseHeaders = new Headers({
    Link: '</ap/notes/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      headers: {
        Accept:
          'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      },
    }),
    responseHeaders,
  );

  assert.equal(response?.status, 307);
  assert.equal(
    response?.headers.get("Location"),
    "https://example.com/ap/notes/1",
  );
});

test("negotiateActivityPubAlternate() honors rejection of its advertised type", () => {
  const responseHeaders = new Headers({
    Link: '</ap/notes/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      headers: {
        Accept:
          "application/activity+json;q=0, application/json;q=1, " +
          "text/html;q=0.5",
      },
    }),
    responseHeaders,
  );

  assert.equal(response, undefined);
  assert.equal(responseHeaders.get("Vary"), "Accept");
});

test("negotiateActivityPubAlternate() ignores non-page responses", () => {
  const responseHeaders = new Headers({
    Link: '</ap/notes/1>; rel="alternate"; type="application/activity+json"',
  });
  const response = negotiateActivityPubAlternate(
    new Request("https://example.com/@alice/1", {
      method: "POST",
      headers: { Accept: "application/activity+json" },
    }),
    responseHeaders,
  );

  assert.equal(response, undefined);
  assert.equal(responseHeaders.has("Vary"), false);
});

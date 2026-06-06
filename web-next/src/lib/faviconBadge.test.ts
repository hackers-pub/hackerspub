import assert from "node:assert";
import test from "node:test";
import {
  buildUnreadNotificationsFaviconSvg,
  createUnreadNotificationsFaviconHref,
  UNREAD_FAVICON_BADGE_ID,
} from "./faviconBadge.ts";

const SOURCE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`;

test("buildUnreadNotificationsFaviconSvg adds a red unread dot with a white ring", () => {
  const favicon = buildUnreadNotificationsFaviconSvg(SOURCE_SVG);

  assert.match(favicon, new RegExp(`id="${UNREAD_FAVICON_BADGE_ID}"`));
  assert.match(favicon, /<circle\b[^>]*fill="#ffffff"/);
  assert.match(favicon, /<circle\b[^>]*fill="#ef4444"/);
});

test("buildUnreadNotificationsFaviconSvg replaces an existing unread badge", () => {
  const once = buildUnreadNotificationsFaviconSvg(SOURCE_SVG);
  const twice = buildUnreadNotificationsFaviconSvg(once);
  const matches = twice.match(
    new RegExp(`id="${UNREAD_FAVICON_BADGE_ID}"`, "g"),
  );

  assert.deepEqual(matches?.length, 1);
});

test("createUnreadNotificationsFaviconHref returns an SVG data URL", () => {
  const href = createUnreadNotificationsFaviconHref(SOURCE_SVG);

  assert.ok(href.startsWith("data:image/svg+xml,"));
  assert.ok(
    decodeURIComponent(href).includes(`id="${UNREAD_FAVICON_BADGE_ID}"`),
  );
});

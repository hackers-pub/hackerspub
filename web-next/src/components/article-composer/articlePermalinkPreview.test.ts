import assert from "node:assert";
import test from "node:test";
import type { ComposeActingAccountOption } from "~/components/ActingAccountSelect.tsx";
import { getArticlePermalinkPreviewPrefix } from "./articlePermalinkPreview.ts";

const actingAccountOptions = [
  {
    value: "personal",
    label: "Dahlia (@dahlia)",
    accounts: [
      {
        id: "personal-account-id",
        name: "Dahlia",
        username: "dahlia",
      },
    ],
  },
  {
    value: "organization:organization-account-id:only",
    accountId: "organization-account-id",
    attributionMode: "ACTING_ACCOUNT_ONLY",
    label: "Hackers' Pub (@hackerspub)",
    accounts: [
      {
        id: "organization-account-id",
        name: "Hackers' Pub",
        username: "hackerspub",
      },
    ],
  },
  {
    value: "organization:organization-account-id:coauthor",
    accountId: "organization-account-id",
    attributionMode: "ACTING_ACCOUNT_WITH_VIEWER",
    label: "Hackers' Pub (@hackerspub) + Dahlia (@dahlia)",
    accounts: [
      {
        id: "organization-account-id",
        name: "Hackers' Pub",
        username: "hackerspub",
      },
      {
        id: "personal-account-id",
        name: "Dahlia",
        username: "dahlia",
      },
    ],
  },
] satisfies readonly ComposeActingAccountOption[];

test("uses the personal account handle for a personal article", () => {
  assert.equal(
    getArticlePermalinkPreviewPrefix({
      origin: "https://hackers.pub",
      routeHandle: "@dahlia",
      year: 2026,
      actingAccountKey: "personal",
      actingAccountOptions,
    }),
    "https://hackers.pub/@dahlia/2026/",
  );
});

test("uses the organization handle for an organization article", () => {
  assert.equal(
    getArticlePermalinkPreviewPrefix({
      origin: "https://hackers.pub",
      routeHandle: "@dahlia",
      year: 2026,
      actingAccountKey: "organization:organization-account-id:only",
      actingAccountOptions,
    }),
    "https://hackers.pub/@hackerspub/2026/",
  );
});

test("uses the organization handle when the viewer is a co-author", () => {
  assert.equal(
    getArticlePermalinkPreviewPrefix({
      origin: "https://hackers.pub",
      routeHandle: "@dahlia",
      year: 2026,
      actingAccountKey: "organization:organization-account-id:coauthor",
      actingAccountOptions,
    }),
    "https://hackers.pub/@hackerspub/2026/",
  );
});

test("falls back to the route handle until account options are available", () => {
  assert.equal(
    getArticlePermalinkPreviewPrefix({
      origin: "",
      routeHandle: "@dahlia",
      year: 2026,
      actingAccountKey: "personal",
      actingAccountOptions: [],
    }),
    "/@dahlia/2026/",
  );
});

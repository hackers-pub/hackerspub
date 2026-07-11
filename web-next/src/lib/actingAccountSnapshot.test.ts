import assert from "node:assert";
import test from "node:test";
import {
  getCompleteActingAccount,
  getCompleteActingOrganizations,
} from "./actingAccountSnapshot.ts";

test("getCompleteActingAccount() rejects incomplete Relay snapshots", () => {
  assert.equal(
    getCompleteActingAccount({ id: "account-id", username: "alice" }),
    null,
  );
  assert.equal(
    getCompleteActingAccount({ id: "account-id", name: "Alice" }),
    null,
  );
});

test("getCompleteActingAccount() copies a complete account", () => {
  assert.deepEqual(
    getCompleteActingAccount({
      id: "account-id",
      name: "Alice",
      username: "alice",
      avatarUrl: null,
    }),
    {
      id: "account-id",
      name: "Alice",
      username: "alice",
      avatarUrl: null,
    },
  );
});

test("getCompleteActingOrganizations() rejects incomplete Relay snapshots", () => {
  assert.equal(
    getCompleteActingOrganizations([{
      role: "MEMBER",
      organization: undefined,
    }]),
    null,
  );
  assert.equal(getCompleteActingOrganizations([undefined]), null);
  assert.equal(
    getCompleteActingOrganizations([{
      role: "MEMBER",
      organization: {},
    }]),
    null,
  );
});

test("getCompleteActingOrganizations() copies complete memberships", () => {
  assert.deepEqual(
    getCompleteActingOrganizations([{
      role: "ADMIN",
      notificationBadge: { color: "RED", count: 2 },
      organization: {
        id: "organization-id",
        name: "Hackers' Pub",
        username: "hackerspub",
        avatarUrl: "https://example.com/avatar.png",
      },
    }]),
    [{
      role: "ADMIN",
      notificationBadge: { color: "RED", count: 2 },
      organization: {
        id: "organization-id",
        name: "Hackers' Pub",
        username: "hackerspub",
        avatarUrl: "https://example.com/avatar.png",
      },
    }],
  );
});

import assert from "node:assert";
import test from "node:test";
import { getCompleteActingOrganizations } from "./actingAccountSnapshot.ts";

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

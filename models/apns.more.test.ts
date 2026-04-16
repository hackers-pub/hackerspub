import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT,
  registerApnsDeviceToken,
  unregisterApnsDeviceToken,
} from "./apns.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

function tokenWithSuffix(suffix: string): string {
  return `${"0".repeat(64 - suffix.length)}${suffix}`;
}

test("registerApnsDeviceToken() reassigns an existing token to the new account", async () => {
  await withRollback(async (tx) => {
    const first = await insertAccountWithActor(tx, {
      username: "apnsfirst",
      name: "APNS First",
      email: "apnsfirst@example.com",
    });
    const second = await insertAccountWithActor(tx, {
      username: "apnssecond",
      name: "APNS Second",
      email: "apnssecond@example.com",
    });
    const token = tokenWithSuffix("1");

    await registerApnsDeviceToken(tx, first.account.id, token);
    const reassigned = await registerApnsDeviceToken(
      tx,
      second.account.id,
      token,
    );

    assert.ok(reassigned != null);
    assert.equal(reassigned.accountId, second.account.id);

    const stored = await tx.query.apnsDeviceTokenTable.findMany({
      where: { deviceToken: token },
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].accountId, second.account.id);
  });
});

test("registerApnsDeviceToken() evicts the oldest token when over the per-account limit", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "apnslimit",
      name: "APNS Limit",
      email: "apnslimit@example.com",
    });

    for (let i = 0; i < MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT; i++) {
      const suffix = (i + 1).toString(16).padStart(2, "0");
      await registerApnsDeviceToken(
        tx,
        account.account.id,
        tokenWithSuffix(suffix),
      );
    }

    const extraToken = tokenWithSuffix("ff");
    await registerApnsDeviceToken(tx, account.account.id, extraToken);

    const tokens = await tx.query.apnsDeviceTokenTable.findMany({
      where: { accountId: account.account.id },
      orderBy: { created: "asc" },
    });
    assert.equal(tokens.length, MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT);
    assert.ok(tokens.some((row) => row.deviceToken === extraToken));
    assert.ok(!tokens.some((row) => row.deviceToken === tokenWithSuffix("01")));
  });
});

test("unregisterApnsDeviceToken() only removes tokens owned by the account", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "apnsowner",
      name: "APNS Owner",
      email: "apnsowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "apnsother",
      name: "APNS Other",
      email: "apnsother@example.com",
    });
    const token = tokenWithSuffix("ab");

    await registerApnsDeviceToken(tx, owner.account.id, token);

    assert.equal(
      await unregisterApnsDeviceToken(tx, other.account.id, token),
      false,
    );
    assert.equal(
      await unregisterApnsDeviceToken(tx, owner.account.id, token),
      true,
    );

    const stored = await tx.query.apnsDeviceTokenTable.findMany({
      where: { deviceToken: token },
    });
    assert.deepEqual(stored, []);
  });
});

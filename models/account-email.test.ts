import assert from "node:assert/strict";
import test from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  AccountEmailError,
  findAccountEmail,
  invalidateEmailVerification,
  removeEmail,
  requestEmailVerification,
  setPrimaryEmail,
  verifyEmail,
} from "./account-email.ts";
import { getAvatarUrl } from "./account.ts";
import {
  accountEmailChallengeTable,
  accountEmailTable,
  accountTable,
} from "./schema.ts";
import { EmailAlreadyRegisteredError, createAccount } from "./signup.ts";
import { generateUuidV7 } from "./uuid.ts";
import type { Transaction } from "./db.ts";
import { db } from "../test/database.ts";
import {
  createTestDisk,
  insertAccountWithActor,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";

const instant = new Date();
function expectCode(result: unknown, code: string) {
  assert.ok(result instanceof AccountEmailError);
  assert.equal(result.code, code);
}

test("email verification binds to account/session, persists attempts, consumes once and keeps secondary hashes private", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailverify",
      name: "Email Verify",
      email: "emailverify@example.com",
    });
    const session = generateUuidV7();
    const beforeAvatar = await getAvatarUrl(createTestDisk(), account);
    const challenge = await requestEmailVerification(
      tx,
      account.id,
      session,
      "Other@example.com",
      instant,
    );
    assert.ok(!(challenge instanceof AccountEmailError));
    assert.equal(await findAccountEmail(tx, challenge.email), undefined);
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        generateUuidV7(),
        challenge.token,
        challenge.code,
        instant,
      ),
      "INVALID_CODE",
    );
    expectCode(
      await verifyEmail(
        tx,
        generateUuidV7(),
        session,
        challenge.token,
        challenge.code,
        instant,
      ),
      "NOT_FOUND",
    );
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        session,
        challenge.token,
        "wrong",
        instant,
      ),
      "INVALID_CODE",
    );
    const [stored] = await tx
      .select()
      .from(accountEmailChallengeTable)
      .where(eq(accountEmailChallengeTable.token, challenge.token));
    assert.equal(stored.attempts, 1);
    assert.notEqual(stored.codeHash, challenge.code);
    const verified = await verifyEmail(
      tx,
      account.id,
      session,
      challenge.token,
      challenge.code.toLowerCase(),
      instant,
    );
    assert.ok(!(verified instanceof AccountEmailError));
    assert.equal(verified.emails.length, 2);
    assert.equal(verified.emails.filter((email) => email.primary).length, 1);
    assert.equal(
      await getAvatarUrl(createTestDisk(), {
        ...account,
        emails: verified.emails,
      }),
      beforeAvatar,
    );
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        session,
        challenge.token,
        challenge.code,
        instant,
      ),
      "INVALID_CODE",
    );
    expectCode(
      await removeEmail(tx, account.id, account.emails[0].email, instant),
      "PRIMARY_EMAIL",
    );
    const switched = await setPrimaryEmail(
      tx,
      account.id,
      "OTHER@example.com",
      instant,
    );
    assert.ok(!(switched instanceof AccountEmailError));
    assert.equal(
      switched.emails.find((email) => email.primary)?.email,
      "Other@example.com",
    );
    const removed = await removeEmail(
      tx,
      account.id,
      account.emails[0].email,
      instant,
    );
    assert.ok(!(removed instanceof AccountEmailError));
    assert.equal(removed.emails.length, 1);
    const row = await tx.query.accountTable.findFirst({
      where: { id: account.id },
    });
    assert.equal(row?.emailCredentialsChanged?.getTime(), instant.getTime());
    expectCode(
      await removeEmail(tx, account.id, "other@example.com", instant),
      "LAST_EMAIL",
    );
  });
});

test("verification expiry and attempt exhaustion cannot be bypassed; new requests replace prior challenges", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailexpiry",
      name: "Expiry",
      email: "emailexpiry@example.com",
    });
    const session = generateUuidV7();
    const first = await requestEmailVerification(
      tx,
      account.id,
      session,
      "first@example.com",
      instant,
    );
    assert.ok(!(first instanceof AccountEmailError));
    for (let attempt = 0; attempt < 5; attempt++)
      expectCode(
        await verifyEmail(tx, account.id, session, first.token, "bad", instant),
        "INVALID_CODE",
      );
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        session,
        first.token,
        first.code,
        instant,
      ),
      "INVALID_CODE",
    );
    const second = await requestEmailVerification(
      tx,
      account.id,
      session,
      "second@example.com",
      new Date(instant.getTime() + 60001),
    );
    assert.ok(!(second instanceof AccountEmailError));
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        session,
        first.token,
        first.code,
        instant,
      ),
      "INVALID_CODE",
    );
    expectCode(
      await verifyEmail(
        tx,
        account.id,
        session,
        second.token,
        second.code,
        new Date(second.expires.getTime()),
      ),
      "INVALID_CODE",
    );
  });
});

test("legacy unverified rows can be verified or removed without gaining premature login access", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emaillegacy",
      name: "Legacy",
      email: "emaillegacy@example.com",
    });
    await tx
      .insert(accountEmailTable)
      .values({ accountId: account.id, email: "legacyother@example.com" });
    expectCode(
      await setPrimaryEmail(tx, account.id, "legacyother@example.com"),
      "UNVERIFIED",
    );
    const session = generateUuidV7();
    const challenge = await requestEmailVerification(
      tx,
      account.id,
      session,
      "legacyother@example.com",
    );
    assert.ok(!(challenge instanceof AccountEmailError));
    const verified = await verifyEmail(
      tx,
      account.id,
      session,
      challenge.token,
      challenge.code,
    );
    assert.ok(!(verified instanceof AccountEmailError));
    assert.equal(verified.emails.length, 2);
    assert.ok(
      verified.emails.find((email) => email.email === "legacyother@example.com")
        ?.verified,
    );
    await tx
      .insert(accountEmailTable)
      .values({ accountId: account.id, email: "unverifiedremove@example.com" });
    assert.ok(
      !(
        (await removeEmail(
          tx,
          account.id,
          "unverifiedremove@example.com",
        )) instanceof AccountEmailError
      ),
    );
    expectCode(
      await removeEmail(tx, account.id, "missing@example.com"),
      "NOT_FOUND",
    );
  });
});

test("verification sending limits count failed deliveries and enforce recipient/account caps", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailthrottle",
      name: "Throttle",
      email: "emailthrottle@example.com",
    });
    const session = generateUuidV7();
    for (let n = 0; n < 3; n++) {
      const challenge = await requestEmailVerification(
        tx,
        account.id,
        session,
        "recipient@example.com",
        new Date(instant.getTime() + n * 60001),
      );
      assert.ok(!(challenge instanceof AccountEmailError));
      await invalidateEmailVerification(tx, challenge.token);
    }
    const recipientLimit = await requestEmailVerification(
      tx,
      account.id,
      session,
      "RECIPIENT@example.com",
      new Date(instant.getTime() + 3 * 60001),
    );
    expectCode(recipientLimit, "RATE_LIMITED");
    assert.ok(
      recipientLimit instanceof AccountEmailError &&
        recipientLimit.retryAfter! > 0,
    );
    for (let n = 3; n < 10; n++) {
      const challenge = await requestEmailVerification(
        tx,
        account.id,
        session,
        `recipient${n}@example.com`,
        new Date(instant.getTime() + n * 60001),
      );
      assert.ok(!(challenge instanceof AccountEmailError));
    }
    expectCode(
      await requestEmailVerification(
        tx,
        account.id,
        session,
        "extra@example.com",
        new Date(instant.getTime() + 10 * 60001),
      ),
      "RATE_LIMITED",
    );
    const nextDay = await requestEmailVerification(
      tx,
      account.id,
      session,
      "extra@example.com",
      new Date(instant.getTime() + 86400001),
    );
    assert.ok(!(nextDay instanceof AccountEmailError));
  });
});

test("case-insensitive uniqueness prevents signup from leaving an account without email", async () => {
  await withRollback(async (tx) => {
    await insertAccountWithActor(tx, {
      username: "emailcase",
      name: "Case",
      email: "EmailCase@example.com",
    });
    const id = generateUuidV7();
    await assert.rejects(
      createAccount(
        tx,
        {
          email: "EMAILCASE@example.com",
          token: generateUuidV7(),
          code: "code",
          created: instant,
        },
        {
          id,
          username: "emailcaseconflict",
          name: "Case Conflict",
          bio: "",
          leftInvitations: 0,
        },
      ),
      EmailAlreadyRegisteredError,
    );
    assert.equal(
      await tx.query.accountTable.findFirst({ where: { id } }),
      undefined,
    );
  });
});

test("separate transactions serialize replay, concurrent ownership claims, additions at the cap and primary changes", async () => {
  await withExclusiveTestDatabase(async () => {
    const fixture = (name: string) =>
      insertAccountWithActor(db as Transaction, {
        username: name,
        name,
        email: `${name}@example.com`,
      });
    const a = await fixture("emailracea");
    const b = await fixture("emailraceb");
    try {
      const sessionA = generateUuidV7();
      const sessionB = generateUuidV7();
      const aChallenge = await requestEmailVerification(
        db,
        a.account.id,
        sessionA,
        "Claim@example.com",
        instant,
      );
      const bChallenge = await requestEmailVerification(
        db,
        b.account.id,
        sessionB,
        "claim@example.com",
        instant,
      );
      assert.ok(!(aChallenge instanceof AccountEmailError));
      assert.ok(!(bChallenge instanceof AccountEmailError));
      const claims = await Promise.all([
        verifyEmail(
          db,
          a.account.id,
          sessionA,
          aChallenge.token,
          aChallenge.code,
          instant,
        ),
        verifyEmail(
          db,
          b.account.id,
          sessionB,
          bChallenge.token,
          bChallenge.code,
          instant,
        ),
      ]);
      assert.equal(
        claims.filter((claim) => !(claim instanceof AccountEmailError)).length,
        1,
      );
      expectCode(
        claims.find((claim) => claim instanceof AccountEmailError),
        "UNAVAILABLE",
      );
      const duplicate = await requestEmailVerification(
        db,
        a.account.id,
        sessionA,
        "double@example.com",
        new Date(instant.getTime() + 60001),
      );
      assert.ok(!(duplicate instanceof AccountEmailError));
      const replays = await Promise.all(
        [1, 2].map(() =>
          verifyEmail(
            db,
            a.account.id,
            sessionA,
            duplicate.token,
            duplicate.code,
            new Date(instant.getTime() + 60001),
          ),
        ),
      );
      assert.equal(
        replays.filter((claim) => !(claim instanceof AccountEmailError)).length,
        1,
      );
      await db.insert(accountEmailTable).values([
        {
          accountId: a.account.id,
          email: "switcha@example.com",
          verified: instant,
        },
        {
          accountId: a.account.id,
          email: "switchb@example.com",
          verified: instant,
        },
      ]);
      await Promise.all([
        setPrimaryEmail(db, a.account.id, "switcha@example.com"),
        setPrimaryEmail(db, a.account.id, "switchb@example.com"),
      ]);
      const primaries = await db
        .select()
        .from(accountEmailTable)
        .where(
          and(
            eq(accountEmailTable.accountId, a.account.id),
            eq(accountEmailTable.primary, true),
          ),
        );
      assert.equal(primaries.length, 1);
      // Insert a valid pending challenge, then reach the cap before confirming it.
      const capChallenge = await requestEmailVerification(
        db,
        b.account.id,
        sessionB,
        "cap@example.com",
        new Date(instant.getTime() + 60001),
      );
      assert.ok(!(capChallenge instanceof AccountEmailError));
      const count = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(accountEmailTable)
        .where(eq(accountEmailTable.accountId, b.account.id));
      for (let n = count[0].count; n < 5; n++)
        await db.insert(accountEmailTable).values({
          accountId: b.account.id,
          email: `cap${n}@example.com`,
          verified: instant,
        });
      expectCode(
        await verifyEmail(
          db,
          b.account.id,
          sessionB,
          capChallenge.token,
          capChallenge.code,
          new Date(instant.getTime() + 60001),
        ),
        "LIMIT_REACHED",
      );
    } finally {
      await db
        .delete(accountTable)
        .where(inArray(accountTable.id, [a.account.id, b.account.id]));
    }
  });
});

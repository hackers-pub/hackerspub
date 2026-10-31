import { assertEquals, assertRejects } from "@std/assert";
import { eq } from "drizzle-orm";
import test from "node:test";
import { db } from "../test/database.ts";
import {
  admitEmailSends,
  finishEmailSend,
  getEmailBudgetUsage,
  nextEmailBudgetReset,
  releaseEmailSend,
  type EmailBudgetLimits,
} from "./email-budget.ts";
import { accountTable, emailSendMonthTable, emailSendTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";

const limits: EmailBudgetLimits = {
  hourlyLimit: 5,
  hourlyHeadroom: 0,
  authReserve: 2,
  digestHourlyCap: 2,
  monthlyLimit: 100,
  monthlyAuthReserve: 10,
};

async function clean(): Promise<void> {
  await db.delete(emailSendTable);
  await db.delete(emailSendMonthTable);
}

test.beforeEach(clean);
test.afterEach(clean);

test("admitEmailSends enforces the hourly total and digest caps", async () => {
  assertEquals((await admitEmailSends(db, "auth", 5, limits))?.length, 5);
  assertEquals(await admitEmailSends(db, "auth", 1, limits), null);

  await clean();
  assertEquals((await admitEmailSends(db, "digest", 2, limits))?.length, 2);
  assertEquals(await admitEmailSends(db, "digest", 1, limits), null);
});

test("admitEmailSends protects the auth reserve", async () => {
  assertEquals(
    (await admitEmailSends(db, "transactional", 3, limits))?.length,
    3,
  );
  assertEquals(await admitEmailSends(db, "digest", 1, limits), null);
  assertEquals((await admitEmailSends(db, "auth", 2, limits))?.length, 2);
});

test("admitEmailSends enforces the monthly non-auth reserve", async () => {
  const monthly: EmailBudgetLimits = {
    ...limits,
    hourlyLimit: 100,
    hourlyHeadroom: 0,
    authReserve: 10,
    digestHourlyCap: 50,
    monthlyLimit: 3,
    monthlyAuthReserve: 1,
  };
  assertEquals(
    (await admitEmailSends(db, "transactional", 2, monthly))?.length,
    2,
  );
  assertEquals(await admitEmailSends(db, "transactional", 1, monthly), null);
  assertEquals((await admitEmailSends(db, "auth", 1, monthly))?.length, 1);
  assertEquals(await admitEmailSends(db, "auth", 1, monthly), null);

  await clean();
  assertEquals((await admitEmailSends(db, "auth", 3, monthly))?.length, 3);
  assertEquals(await admitEmailSends(db, "transactional", 1, monthly), null);
});

test("releaseEmailSend only releases an unsubmitted admission", async () => {
  const [admission] = (await admitEmailSends(db, "auth", 1, limits))!;
  assertEquals(await releaseEmailSend(db, admission.id), true);
  assertEquals(await releaseEmailSend(db, admission.id), false);

  const [submitted] = (await admitEmailSends(db, "auth", 1, limits))!;
  await finishEmailSend(db, submitted.id, {
    accepted: true,
    providerRef: "ref-1",
  });
  assertEquals(await releaseEmailSend(db, submitted.id), false);
});

test("releaseEmailSend decrements the month it was admitted in", async () => {
  const [row] = await db
    .insert(emailSendTable)
    .values({
      priority: "auth",
      admitted: new Date("2026-09-30T23:59:59Z"),
    })
    .returning({ id: emailSendTable.id });
  await db.insert(emailSendMonthTable).values([
    { month: "2026-09-01", priority: "auth", sent: 1 },
    { month: "2026-10-01", priority: "auth", sent: 2 },
  ]);

  assertEquals(await releaseEmailSend(db, row.id), true);

  const months = await db.select().from(emailSendMonthTable);
  assertEquals(
    months
      .map((month) => ({ month: month.month, sent: month.sent }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    [
      { month: "2026-09-01", sent: 0 },
      { month: "2026-10-01", sent: 2 },
    ],
  );
});

test("the digest dedup index blocks pending and ambiguous but not rejected sends", async () => {
  const accountId = generateUuidV7();
  await db.insert(accountTable).values({
    id: accountId,
    username: `budget_${accountId.slice(0, 8)}`,
    name: "Budget test",
    bio: "",
    leftInvitations: 0,
  });
  const metadata = {
    accountId,
    deliveryFrequency: "daily" as const,
    deliveryPeriod: new Date("2026-10-31T00:00:00Z"),
    recipientHashes: ["recipient"],
  };
  try {
    const [first] = (await admitEmailSends(db, "digest", 1, limits, metadata))!;
    await assertRejects(
      () => admitEmailSends(db, "digest", 1, limits, metadata),
      Error,
    );

    await finishEmailSend(db, first.id, { accepted: null });
    await assertRejects(
      () => admitEmailSends(db, "digest", 1, limits, metadata),
      Error,
    );

    await finishEmailSend(db, first.id, { accepted: false });
    const [retry] = (await admitEmailSends(db, "digest", 1, limits, metadata))!;
    assertEquals(retry.priority, "digest");
  } finally {
    await db.delete(accountTable).where(eq(accountTable.id, accountId));
  }
});

test("getEmailBudgetUsage reports when a rolling slot frees up", async () => {
  const admitted = new Date(Date.now() - 30 * 60 * 1000);
  await db.insert(emailSendTable).values({ priority: "auth", admitted });

  const usage = await getEmailBudgetUsage(db);
  assertEquals(usage.total, 1);
  assertEquals(
    Math.abs(usage.nextAvailable.getTime() - (admitted.getTime() + 3_600_000)) <
      1_000,
    true,
  );
});

test("finishEmailSend records accepted, rejected and ambiguous outcomes", async () => {
  for (const accepted of [true, false, null]) {
    const [admission] = (await admitEmailSends(db, "auth", 1, limits))!;
    await finishEmailSend(db, admission.id, {
      accepted,
      providerRef: accepted === true ? "ref" : null,
    });
  }
  const usage = await getEmailBudgetUsage(db);
  assertEquals(usage.total, 3);
  assertEquals(usage.auth, 3);
  assertEquals(usage.monthlyTotal, 3);
});

test("admitEmailSends requires one recipient hash per message", async () => {
  await assertRejects(
    () =>
      admitEmailSends(db, "digest", 2, limits, {
        recipientHashes: ["one"],
      }),
    TypeError,
  );
});

test("nextEmailBudgetReset returns the next UTC hour", () => {
  assertEquals(
    nextEmailBudgetReset(new Date("2026-10-31T14:32:10Z")).toISOString(),
    "2026-10-31T15:00:00.000Z",
  );
});

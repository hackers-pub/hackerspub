import { assertEquals, assertRejects } from "@std/assert";
import {
  createMessage,
  type Message,
  type Receipt,
  type Transport,
  type TransportOptions,
} from "@upyo/core";
import test from "node:test";
import {
  BudgetedTransport,
  classifyReceipt,
  createEmailTransports,
  EmailBudgetExhaustedError,
  type EmailBudget,
} from "./email.ts";
import type { Database } from "@hackerspub/models/db";
import type { AdmittedEmailSend } from "@hackerspub/models/email-budget";
import type { EmailPriority } from "@hackerspub/models/schema";
import type { EmailBudgetConfig } from "./config.ts";

const message = createMessage({
  from: "noreply@example.com",
  to: "user@example.com",
  subject: "Test",
  content: { text: "Hello" },
});

function receipt(successful = true): Receipt {
  return {
    successful,
    provider: "fake",
    messageId: successful ? "message-1" : undefined,
    errorMessages: successful ? [] : ["rejected"],
  } as unknown as Receipt;
}

function failedReceipt(category: string): Receipt {
  return {
    successful: false,
    provider: "fake",
    errorMessages: [category],
    errors: [
      {
        message: category,
        code: category,
        category,
        retryable: category !== "rejected",
      },
    ],
  } as unknown as Receipt;
}

class FakeInner implements Transport {
  readonly id = "fake";
  readonly messages: Message[] = [];
  readonly #outcome: "success" | "throw";

  constructor(outcome: "success" | "throw" = "success") {
    this.#outcome = outcome;
  }

  async send(message: Message): Promise<Receipt> {
    this.messages.push(message);
    if (this.#outcome === "throw") throw new Error("provider failed");
    return receipt();
  }

  sendMany(
    messages: Iterable<Message>,
    options?: TransportOptions,
  ): AsyncIterable<Receipt>;
  sendMany(
    messages: AsyncIterable<Message>,
    options?: TransportOptions,
  ): AsyncIterable<Receipt>;
  async *sendMany(
    messages: Iterable<Message> | AsyncIterable<Message>,
    _options?: TransportOptions,
  ): AsyncIterable<Receipt> {
    for await (const message of messages) yield await this.send(message);
  }
}

class FakeBudget implements EmailBudget {
  readonly admissions: AdmittedEmailSend[] = [];
  readonly finished: Array<{
    id: string;
    receipt: Receipt | undefined;
  }> = [];
  readonly #available: boolean;
  readonly #finishError?: Error;

  constructor(available = true, finishError?: Error) {
    this.#available = available;
    this.#finishError = finishError;
  }

  async admit(priority: EmailPriority): Promise<AdmittedEmailSend | null> {
    if (!this.#available) return null;
    const admission = { id: `admission-${this.admissions.length}`, priority };
    this.admissions.push(admission);
    return admission;
  }

  async finish(id: string, receipt: Receipt | undefined): Promise<void> {
    this.finished.push({ id, receipt });
    if (this.#finishError != null) throw this.#finishError;
  }

  async nextAvailable(): Promise<Date> {
    return new Date("2026-10-31T15:00:00Z");
  }
}

const budgetConfig: EmailBudgetConfig = {
  hourlyLimit: 1000,
  hourlyHeadroom: 100,
  authReserve: 100,
  digestHourlyCap: 300,
  digestScanLimit: 60,
  digestSendLimit: 25,
  digestMaxAttempts: 3,
  digestRetryMinutes: 15,
  digestWindowStart: "00:05",
  digestWindowEnd: "08:00",
  digestCatchupEnd: "12:00",
  digestBatchSeconds: 180,
  monthlyLimit: 25000,
  monthlyAuthReserve: 1000,
  digestEnabled: true,
};

test("createEmailTransports assigns the correct priority to each class", () => {
  const raw = new FakeInner();
  const transports = createEmailTransports(
    raw,
    "maileroo",
    budgetConfig,
    {} as Database,
  );

  assertEquals(
    (transports.email as BudgetedTransport).priority,
    "transactional",
  );
  assertEquals((transports.emailAuth as BudgetedTransport).priority, "auth");
  assertEquals(
    (transports.digestEmail as BudgetedTransport).priority,
    "digest",
  );
});

test("createEmailTransports leaves mock and log transports unbudgeted", () => {
  const raw = new FakeInner();
  for (const transport of ["mock", "logtape"] as const) {
    const transports = createEmailTransports(
      raw,
      transport,
      budgetConfig,
      {} as Database,
    );
    assertEquals(transports.email, raw);
    assertEquals(transports.emailAuth, raw);
    assertEquals(transports.digestEmail, raw);
  }
});

test("classifyReceipt separates rejection from ambiguous failures", () => {
  assertEquals(classifyReceipt(receipt()), true);
  assertEquals(classifyReceipt(failedReceipt("rejected")), false);
  assertEquals(classifyReceipt(failedReceipt("validation")), false);
  assertEquals(classifyReceipt(failedReceipt("timeout")), null);
  assertEquals(classifyReceipt(failedReceipt("network")), null);
  assertEquals(classifyReceipt(failedReceipt("unknown")), null);
  assertEquals(classifyReceipt(undefined), null);
});

test("BudgetedTransport admits once and records the receipt", async () => {
  const inner = new FakeInner();
  const budget = new FakeBudget();
  const transport = new BudgetedTransport(inner, budget, "auth");

  const result = await transport.send(message);

  assertEquals(result.successful, true);
  assertEquals(budget.admissions.length, 1);
  assertEquals(budget.finished.length, 1);
  assertEquals(
    (budget.finished[0].receipt as { messageId?: string } | undefined)
      ?.messageId,
    "message-1",
  );
});

test("transactional budget exhaustion returns a failed receipt", async () => {
  const inner = new FakeInner();
  const budget = new FakeBudget(false);
  const transport = new BudgetedTransport(inner, budget, "transactional");

  const result = await transport.send(message);

  assertEquals(result.successful, false);
  assertEquals(inner.messages.length, 0);
});

test("digest budget exhaustion throws a retryable budget error", async () => {
  const inner = new FakeInner();
  const budget = new FakeBudget(false);
  const transport = new BudgetedTransport(inner, budget, "digest");

  await assertRejects(() => transport.send(message), EmailBudgetExhaustedError);
  assertEquals(inner.messages.length, 0);
});

test("a provider exception records an ambiguous outcome and rethrows", async () => {
  const inner = new FakeInner("throw");
  const budget = new FakeBudget();
  const transport = new BudgetedTransport(inner, budget, "auth");

  await assertRejects(() => transport.send(message), Error, "provider failed");
  assertEquals(budget.finished.length, 1);
  assertEquals(budget.finished[0].receipt, undefined);
});

test("bookkeeping failure does not turn a provider success into a retry", async () => {
  const inner = new FakeInner();
  const budget = new FakeBudget(true, new Error("ledger unavailable"));
  const transport = new BudgetedTransport(inner, budget, "auth");

  const result = await transport.send(message);

  assertEquals(result.successful, true);
  assertEquals(budget.finished.length, 1);
});

test("sendMany charges each message separately", async () => {
  const inner = new FakeInner();
  const budget = new FakeBudget();
  const transport = new BudgetedTransport(inner, budget, "auth");

  const receipts: Receipt[] = [];
  for await (const result of transport.sendMany([message, message])) {
    receipts.push(result);
  }

  assertEquals(receipts.length, 2);
  assertEquals(budget.admissions.length, 2);
  assertEquals(budget.finished.length, 2);
});

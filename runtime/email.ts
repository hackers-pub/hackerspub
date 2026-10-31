import { getLogger } from "@logtape/logtape";
import {
  createFailedReceipt,
  type Message,
  type Receipt,
  type Transport,
  type TransportOptions,
} from "@upyo/core";
import type { Database } from "@hackerspub/models/db";
import {
  admitEmailSends,
  finishEmailSend,
  getEmailBudgetUsage,
  type AdmittedEmailSend,
  type EmailBudgetLimits,
} from "@hackerspub/models/email-budget";
import type { EmailPriority } from "@hackerspub/models/schema";
import type { EmailBudgetConfig, EmailConfig } from "./config.ts";

const logger = getLogger(["hackerspub", "email", "budget"]);

export class EmailBudgetExhaustedError extends Error {
  readonly resets: Date;

  constructor(resets: Date) {
    super(
      `The email budget is exhausted; it frees up around ${resets.toISOString()}.`,
    );
    this.name = "EmailBudgetExhaustedError";
    this.resets = resets;
  }
}

/**
 * `successful: false` is not enough to call a message rejected: Maileroo and
 * Upyo also use failed receipts for timeouts and unknown outcomes.  Only
 * structured, non-retryable validation/auth/rejection errors are definite.
 */
export function classifyReceipt(receipt: Receipt | undefined): boolean | null {
  if (receipt == null) return null;
  if (receipt.successful) return true;
  const errors = receipt.errors;
  if (errors == null || errors.length < 1) return null;
  const definite = new Set(["auth", "validation", "rejected", "configuration"]);
  return errors.every((error) => definite.has(error.category)) ? false : null;
}

export interface EmailBudget {
  admit(priority: EmailPriority): Promise<AdmittedEmailSend | null>;
  finish(id: string, receipt: Receipt | undefined): Promise<void>;
  nextAvailable(): Promise<Date>;
}

class PostgresEmailBudget implements EmailBudget {
  readonly #db: Database;
  readonly #limits: EmailBudgetLimits;

  constructor(db: Database, config: EmailBudgetConfig) {
    this.#db = db;
    this.#limits = {
      hourlyLimit: config.hourlyLimit,
      hourlyHeadroom: config.hourlyHeadroom,
      authReserve: config.authReserve,
      digestHourlyCap: config.digestHourlyCap,
      monthlyLimit: config.monthlyLimit,
      monthlyAuthReserve: config.monthlyAuthReserve,
    };
  }

  async admit(priority: EmailPriority): Promise<AdmittedEmailSend | null> {
    const admissions = await admitEmailSends(
      this.#db,
      priority,
      1,
      this.#limits,
    );
    return admissions?.[0] ?? null;
  }

  async finish(id: string, receipt: Receipt | undefined): Promise<void> {
    await finishEmailSend(this.#db, id, {
      accepted: classifyReceipt(receipt),
      providerRef: receipt?.successful === true ? receipt.messageId : null,
    });
  }

  async nextAvailable(): Promise<Date> {
    return (await getEmailBudgetUsage(this.#db)).nextAvailable;
  }
}

export interface EmailTransports {
  readonly email: Transport;
  readonly emailAuth: Transport;
  readonly digestEmail: Transport;
}

/**
 * A transport that charges one admission per message.  Provider success is
 * returned even if recording it fails: losing the bookkeeping update must not
 * turn an accepted message into a retryable failure.
 */
export class BudgetedTransport implements Transport {
  readonly id: string;
  readonly priority: EmailPriority;
  readonly #inner: Transport;
  readonly #budget: EmailBudget;

  constructor(inner: Transport, budget: EmailBudget, priority: EmailPriority) {
    this.id = inner.id;
    this.priority = priority;
    this.#inner = inner;
    this.#budget = budget;
  }

  async send(message: Message, options?: TransportOptions): Promise<Receipt> {
    const admission = await this.#budget.admit(this.priority);
    if (admission == null) {
      if (this.priority === "digest") {
        throw new EmailBudgetExhaustedError(await this.#budget.nextAvailable());
      }
      return createFailedReceipt(
        "Email capacity is temporarily exhausted; retry shortly.",
      );
    }

    try {
      const receipt = await this.#inner.send(message, options);
      try {
        await this.#budget.finish(admission.id, receipt);
      } catch (error) {
        logger.error(
          "Failed to record email admission {admissionId} after sending: {error}",
          { admissionId: admission.id, error },
        );
      }
      return receipt;
    } catch (error) {
      try {
        await this.#budget.finish(admission.id, undefined);
      } catch (bookkeepingError) {
        logger.error(
          "Failed to record ambiguous email admission {admissionId}: {error}",
          { admissionId: admission.id, error: bookkeepingError },
        );
      }
      throw error;
    }
  }

  async *sendMany(
    messages: Iterable<Message> | AsyncIterable<Message>,
    options?: TransportOptions,
  ): AsyncIterable<Receipt> {
    for await (const message of messages) {
      yield await this.send(message, options);
    }
  }
}

export function createEmailTransports(
  raw: Transport,
  transport: EmailConfig["transport"],
  budget: EmailBudgetConfig,
  db: Database,
): EmailTransports {
  if (transport !== "maileroo") {
    return { email: raw, emailAuth: raw, digestEmail: raw };
  }
  const admission = new PostgresEmailBudget(db, budget);
  return {
    email: new BudgetedTransport(raw, admission, "transactional"),
    emailAuth: new BudgetedTransport(raw, admission, "auth"),
    digestEmail: new BudgetedTransport(raw, admission, "digest"),
  };
}

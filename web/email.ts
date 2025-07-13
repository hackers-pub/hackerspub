import { getLogger } from "@logtape/logtape";
import Mailgun from "@schotsl/mailgun";
import type { Transport } from "@upyo/core";
import { MailgunTransport } from "@upyo/mailgun";

const logger = getLogger(["hackerspub", "email"]);

function getEnv(variable: string): string {
  const val = Deno.env.get(variable);
  if (val == null) throw new Error(`Missing environment variable: ${variable}`);
  return val;
}

const MAILGUN_KEY = getEnv("MAILGUN_KEY");
const MAILGUN_REGION = getEnv("MAILGUN_REGION");
const MAILGUN_DOMAIN = getEnv("MAILGUN_DOMAIN");
const MAILGUN_FROM = Deno.env.get("EMAIL_FROM") ?? getEnv("MAILGUN_FROM");

const mailgun = new Mailgun({
  key: MAILGUN_KEY,
  region: MAILGUN_REGION === "eu" ? "eu" : "us",
  domain: MAILGUN_DOMAIN,
});

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(email: Email): Promise<void> {
  const params = { from: MAILGUN_FROM, ...email };
  logger.debug("Sending email... {*}", params);
  await mailgun.send(params);
}

export const transport: Transport = new MailgunTransport({
  apiKey: MAILGUN_KEY,
  domain: MAILGUN_DOMAIN,
  region: MAILGUN_REGION === "eu" ? "eu" : "us",
});

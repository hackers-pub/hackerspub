import type { Transport } from "@upyo/core";
import { MailgunTransport } from "@upyo/mailgun";

function getEnv(variable: string): string {
  const val = Deno.env.get(variable);
  if (val == null) throw new Error(`Missing environment variable: ${variable}`);
  return val;
}

export const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? getEnv("MAILGUN_FROM");
const MAILGUN_KEY = getEnv("MAILGUN_KEY");
const MAILGUN_REGION = getEnv("MAILGUN_REGION");
const MAILGUN_DOMAIN = getEnv("MAILGUN_DOMAIN");

export const transport: Transport = new MailgunTransport({
  apiKey: MAILGUN_KEY,
  domain: MAILGUN_DOMAIN,
  region: MAILGUN_REGION === "eu" ? "eu" : "us",
});

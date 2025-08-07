import type { Transport } from "@upyo/core";
import { MailgunTransport } from "@upyo/mailgun";
import { MockTransport } from "@upyo/mock";

function getEnv(variable: string): string {
  const val = Deno.env.get(variable);
  if (val == null) throw new Error(`Missing environment variable: ${variable}`);
  return val;
}

export const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? getEnv("MAILGUN_FROM");

if (EMAIL_FROM === "") {
  throw new Error(
    "EMAIL_FROM or MAILGUN_FROM cannot be an empty string. Please set it in your environment variables.",
  );
}

export const transport: Transport = Deno.env.get("CI") === "true"
  ? new MockTransport()
  : new MailgunTransport({
    apiKey: getEnv("MAILGUN_KEY"),
    domain: getEnv("MAILGUN_DOMAIN"),
    region: getEnv("MAILGUN_REGION") === "eu" ? "eu" : "us",
  });

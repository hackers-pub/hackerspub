import Mailgun from "@schotsl/mailgun";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hackerspub", "email"]);

function getEnv(variable: string): string {
  const val = Deno.env.get(variable);
  if (val == null) throw new Error(`Missing environment variable: ${variable}`);
  return val;
}

const MAILGUN_KEY = getEnv("MAILGUN_KEY");
const MAILGUN_REGION = getEnv("MAILGUN_REGION");
const MAILGUN_DOMAIN = getEnv("MAILGUN_DOMAIN");
const MAILGUN_FROM = getEnv("MAILGUN_FROM");

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

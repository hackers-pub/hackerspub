import { kv } from "@hackerspub/web/kv";
import { createSignupToken } from "../models/signup.ts";
import { ORIGIN } from "../web/federation.ts";

export async function createSignupLink(email: string): Promise<URL> {
  const token = await createSignupToken(kv, email);
  const verifyUrl = new URL(`/sign/up/${token.token}`, ORIGIN);
  verifyUrl.searchParams.set("code", token.code);
  return verifyUrl;
}

export async function main() {
  const email = Deno.args[0];
  if (!email) {
    console.error("Error: Please provide an email address.");
    console.error("Usage: deno task addaccount EMAIL");
    Deno.exit(1);
  }
  try {
    const signupLink = await createSignupLink(email);
    console.error(`Signup link for ${email}:\n`);
    console.log(signupLink.href);
  } catch (error) {
    console.error("Error creating signup link:", error);
  }
}

if (import.meta.main) await main();

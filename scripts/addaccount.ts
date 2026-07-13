import { createSignupToken } from "@hackerspub/models/signup";
import {
  getDenoEnvironment,
  loadAccountCreationConfig,
} from "@hackerspub/runtime/config";
import { createKeyValueResource } from "@hackerspub/runtime/resources";
import type Keyv from "keyv";

export async function createSignupLink(
  kv: Keyv,
  origin: URL,
  email: string,
): Promise<URL> {
  const token = await createSignupToken(kv, email);
  const verifyUrl = new URL(`/sign/up/${token.token}`, origin);
  verifyUrl.searchParams.set("code", token.code);
  return verifyUrl;
}

export async function main() {
  const email = Deno.args[0];
  if (!email) {
    console.error("Error: Please provide an email address.");
    console.error("Usage: mise run addaccount EMAIL");
    Deno.exit(1);
  }
  const config = loadAccountCreationConfig(getDenoEnvironment());
  const kv = createKeyValueResource(config.kv);
  try {
    const signupLink = await createSignupLink(kv, config.origin, email);
    console.error(`Signup link for ${email}:\n`);
    console.log(signupLink.href);
  } catch (error) {
    console.error("Error creating signup link:", error);
    Deno.exitCode = 1;
  } finally {
    await kv.disconnect();
  }
}

if (import.meta.main) await main();

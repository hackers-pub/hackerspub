import { createSignupToken } from "@hackerspub/models/signup";
import {
  getProcessEnvironment,
  loadAccountCreationConfig,
} from "@hackerspub/runtime/config";
import { isMain } from "@hackerspub/runtime/main";
import { createKeyValueResource } from "@hackerspub/runtime/resources";
import type Keyv from "keyv";
import process from "node:process";

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

export async function main(args = process.argv.slice(2)) {
  const email = args[0];
  if (!email) {
    console.error("Error: Please provide an email address.");
    console.error("Usage: mise run addaccount EMAIL");
    process.exitCode = 1;
    return;
  }
  const config = loadAccountCreationConfig(getProcessEnvironment());
  const kv = createKeyValueResource(config.kv);
  try {
    const signupLink = await createSignupLink(kv, config.origin, email);
    console.error(`Signup link for ${email}:\n`);
    console.log(signupLink.href);
  } catch (error) {
    console.error("Error creating signup link:", error);
    process.exitCode = 1;
  } finally {
    await kv.disconnect();
  }
}

if (isMain(import.meta)) await main();

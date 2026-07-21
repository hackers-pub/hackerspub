import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigurationError,
  loadAccountCreationConfig,
  loadDatabaseConfig,
  loadServerConfig,
  loadStandaloneServerConfig,
} from "./config.ts";

const required = {
  DATABASE_URL: "postgres://localhost/hackerspub",
  DRIVE_DISK: "fs",
  FS_LOCATION: "./data",
  KV_URL: "file:///tmp/hackerspub-kv.json",
  ORIGIN: "https://hackers.pub",
  CI: "true",
  EMAIL_FROM: "noreply@hackers.pub",
};

Deno.test("loadDatabaseConfig requires only DATABASE_URL", () => {
  assertEquals(
    loadDatabaseConfig({ DATABASE_URL: required.DATABASE_URL }),
    { url: required.DATABASE_URL },
  );
});

Deno.test("loadAccountCreationConfig requires only ORIGIN and KV_URL", () => {
  const config = loadAccountCreationConfig({
    ORIGIN: required.ORIGIN,
    KV_URL: required.KV_URL,
  });

  assertEquals(config.origin.href, "https://hackers.pub/");
  assertEquals(config.kv.url.href, required.KV_URL);
});

Deno.test("loadServerConfig parses runtime configuration without reading Deno.env", () => {
  const config = loadServerConfig(required);

  assertEquals(config.database.url, required.DATABASE_URL);
  assertEquals(config.origin.href, "https://hackers.pub/");
  assertEquals(config.kv.url.href, required.KV_URL);
  assertEquals(config.storage, { driver: "fs", location: "./data" });
  assertEquals(config.email, {
    transport: "mock",
    from: "noreply@hackers.pub",
    reason: "ci",
  });
});

Deno.test("loadStandaloneServerConfig requires a process-safe shared KV", () => {
  const error = assertThrows(
    () => loadStandaloneServerConfig(required),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(error.issues, [{
    variable: "KV_URL",
    message: "must use redis for standalone GraphQL services",
  }]);

  const config = loadStandaloneServerConfig({
    ...required,
    KV_URL: "redis://localhost:6379/0",
  });
  assertEquals(config.kv.url.href, "redis://localhost:6379/0");
});

Deno.test("loadServerConfig uses mock email in development without Mailgun", () => {
  const { CI: _ci, EMAIL_FROM: _emailFrom, ...withoutEmail } = required;
  const config = loadServerConfig({ ...withoutEmail, MODE: "development" });

  assertEquals(config.email, {
    transport: "mock",
    from: "noreply@hackers.pub",
    reason: "mailgun-unconfigured",
  });
});

Deno.test("loadServerConfig ignores sender and region without Mailgun credentials", () => {
  const { CI: _ci, ...withoutCi } = required;
  const config = loadServerConfig({
    ...withoutCi,
    MODE: "development",
    MAILGUN_FROM: "legacy@hackers.pub",
    MAILGUN_REGION: "us",
  });

  assertEquals(config.email, {
    transport: "mock",
    from: "noreply@hackers.pub",
    reason: "mailgun-unconfigured",
  });
});

Deno.test("loadServerConfig requires Mailgun in the default production mode", () => {
  const { CI: _ci, ...withoutCi } = required;
  const error = assertThrows(
    () => loadServerConfig({ ...withoutCi, MAILGUN_REGION: "us" }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.map((issue) => issue.variable).toSorted(),
    ["MAILGUN_DOMAIN", "MAILGUN_KEY"],
  );
});

Deno.test("loadServerConfig rejects partial Mailgun configuration", () => {
  const { CI: _ci, EMAIL_FROM: _emailFrom, ...withoutEmail } = required;
  const error = assertThrows(
    () => loadServerConfig({ ...withoutEmail, MAILGUN_KEY: "key" }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.map((issue) => issue.variable).toSorted(),
    ["EMAIL_FROM", "MAILGUN_DOMAIN", "MAILGUN_REGION"],
  );
});

Deno.test("loadServerConfig reports missing and invalid values as typed issues", () => {
  const error = assertThrows(
    () => loadServerConfig({ ORIGIN: "ftp://example.com", KV_URL: "nope" }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.some((issue) => issue.variable === "DATABASE_URL"),
    true,
  );
  assertEquals(error.issues.some((issue) => issue.variable === "ORIGIN"), true);
  assertEquals(error.issues.some((issue) => issue.variable === "KV_URL"), true);
});

Deno.test("loadServerConfig requires the complete selected storage configuration", () => {
  const error = assertThrows(
    () =>
      loadServerConfig({
        ...required,
        DRIVE_DISK: "s3",
        FS_LOCATION: undefined,
        AWS_ACCESS_KEY_ID: "key",
      }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.map((issue) => issue.variable).toSorted(),
    ["AWS_REGION", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET"],
  );
});

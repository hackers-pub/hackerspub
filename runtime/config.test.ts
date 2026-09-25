import { assertEquals, assertThrows } from "@std/assert";
import test from "node:test";
import {
  ConfigurationError,
  loadAccountCreationConfig,
  loadDatabaseConfig,
  loadGraphqlApiConfig,
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

test("loadDatabaseConfig requires only DATABASE_URL", () => {
  assertEquals(loadDatabaseConfig({ DATABASE_URL: required.DATABASE_URL }), {
    url: required.DATABASE_URL,
  });
});

test("loadAccountCreationConfig requires only ORIGIN and KV_URL", () => {
  const config = loadAccountCreationConfig({
    ORIGIN: required.ORIGIN,
    KV_URL: required.KV_URL,
  });

  assertEquals(config.origin.href, "https://hackers.pub/");
  assertEquals(config.kv.url.href, required.KV_URL);
});

test("loadServerConfig parses runtime configuration without reading Deno.env", () => {
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

test("loadStandaloneServerConfig requires a process-safe shared KV", () => {
  const error = assertThrows(
    () => loadStandaloneServerConfig(required),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(error.issues, [
    {
      variable: "KV_URL",
      message: "must use redis for standalone GraphQL services",
    },
  ]);

  const config = loadStandaloneServerConfig({
    ...required,
    KV_URL: "redis://localhost:6379/0",
  });
  assertEquals(config.kv.url.href, "redis://localhost:6379/0");

  const tlsConfig = loadStandaloneServerConfig({
    ...required,
    KV_URL: "rediss://redis.example:6379/0",
  });
  assertEquals(tlsConfig.kv.url.href, "rediss://redis.example:6379/0");
});

test("loadGraphqlApiConfig permits file KV only when explicitly allowed", () => {
  assertThrows(() => loadGraphqlApiConfig(required), ConfigurationError);
  assertThrows(
    () => loadGraphqlApiConfig(required, { allowFileKv: true }),
    ConfigurationError,
  );

  const config = loadGraphqlApiConfig(
    { ...required, MODE: "development" },
    { allowFileKv: true },
  );
  assertEquals(config.kv.url.href, required.KV_URL);
});

test("loadServerConfig uses mock email in development without Maileroo", () => {
  const { CI: _ci, EMAIL_FROM: _emailFrom, ...withoutEmail } = required;
  const config = loadServerConfig({ ...withoutEmail, MODE: "development" });

  assertEquals(config.email, {
    transport: "mock",
    from: "noreply@hackers.pub",
    reason: "maileroo-unconfigured",
  });
});

test("loadServerConfig keeps the sender when Maileroo is unconfigured", () => {
  const { CI: _ci, ...withoutCi } = required;
  const config = loadServerConfig({
    ...withoutCi,
    MODE: "development",
    EMAIL_FROM: "admin@hackers.pub",
  });

  assertEquals(config.email, {
    transport: "mock",
    from: "admin@hackers.pub",
    reason: "maileroo-unconfigured",
  });
});

test("loadServerConfig selects Maileroo when its key is configured", () => {
  const { CI: _ci, ...withoutCi } = required;
  const config = loadServerConfig({
    ...withoutCi,
    MODE: "development",
    MAILEROO_KEY: " key ",
  });

  assertEquals(config.email, {
    transport: "maileroo",
    from: "noreply@hackers.pub",
    apiKey: "key",
  });
});

test("loadServerConfig requires Maileroo in the default production mode", () => {
  const { CI: _ci, ...withoutCi } = required;
  const error = assertThrows(
    () => loadServerConfig(withoutCi),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.map((issue) => issue.variable),
    ["MAILEROO_KEY"],
  );
});

test("loadServerConfig requires a sender for Maileroo", () => {
  const { CI: _ci, EMAIL_FROM: _emailFrom, ...withoutEmail } = required;
  const error = assertThrows(
    () => loadServerConfig({ ...withoutEmail, MAILEROO_KEY: "key" }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.map((issue) => issue.variable),
    ["EMAIL_FROM"],
  );
});

test("loadServerConfig reports missing and invalid values as typed issues", () => {
  const error = assertThrows(
    () => loadServerConfig({ ORIGIN: "ftp://example.com", KV_URL: "nope" }),
    ConfigurationError,
  ) as ConfigurationError;

  assertEquals(
    error.issues.some((issue) => issue.variable === "DATABASE_URL"),
    true,
  );
  assertEquals(
    error.issues.some((issue) => issue.variable === "ORIGIN"),
    true,
  );
  assertEquals(
    error.issues.some((issue) => issue.variable === "KV_URL"),
    true,
  );
});

test("loadServerConfig requires the complete selected storage configuration", () => {
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

  assertEquals(error.issues.map((issue) => issue.variable).toSorted(), [
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "S3_BUCKET",
  ]);
});

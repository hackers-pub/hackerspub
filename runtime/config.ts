export interface Environment {
  readonly [variable: string]: string | undefined;
}

export interface ConfigurationIssue {
  readonly variable: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    super(
      `Invalid server configuration:\n${issues
        .map(({ variable, message }) => `- ${variable}: ${message}`)
        .join("\n")}`,
    );
    this.issues = issues;
    this.name = "ConfigurationError";
  }
}

export type StorageConfig =
  | { readonly driver: "fs"; readonly location: string }
  | {
      readonly driver: "s3";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly region: string;
      readonly bucket: string;
      readonly endpoint?: string;
      readonly cdnUrl?: string;
    };

export type EmailConfig =
  | {
      readonly transport: "mock";
      readonly from: string;
      readonly reason: "ci";
    }
  | {
      readonly transport: "logtape";
      readonly from: string;
    }
  | {
      readonly transport: "maileroo";
      readonly from: string;
      readonly apiKey: string;
    };

export interface EmailBudgetConfig {
  readonly hourlyLimit: number;
  readonly hourlyHeadroom: number;
  readonly authReserve: number;
  readonly digestHourlyCap: number;
  readonly digestScanLimit: number;
  readonly digestSendLimit: number;
  readonly digestMaxAttempts: number;
  readonly digestRetryMinutes: number;
  readonly digestWindowStart: string;
  readonly digestWindowEnd: string;
  readonly digestCatchupEnd: string;
  readonly digestBatchSeconds: number;
  readonly monthlyLimit: number;
  readonly monthlyAuthReserve: number;
  readonly digestEnabled: boolean;
}

export interface DatabaseConfig {
  readonly url: string;
}

export interface KeyValueConfig {
  readonly url: URL;
}

export interface AccountCreationConfig {
  readonly origin: URL;
  readonly kv: KeyValueConfig;
}

export interface ServerConfig {
  readonly database: DatabaseConfig;
  readonly origin: URL;
  readonly kv: KeyValueConfig;
  readonly storage: StorageConfig;
  readonly email: EmailConfig;
  readonly emailBudget: EmailBudgetConfig;
  readonly ai: {
    readonly altTextModel: string;
    readonly summarizerModel: string;
    readonly translatorModel: string;
    readonly moderationModel: string;
  };
  readonly behindProxy: boolean;
  readonly mode: string;
}

function nonEmpty(
  env: Environment,
  variable: string,
  issues: ConfigurationIssue[],
): string | undefined {
  const value = env[variable]?.trim();
  if (value == null || value === "") {
    issues.push({ variable, message: "is required" });
    return undefined;
  }
  return value;
}

const DEFAULT_EMAIL_BUDGET: EmailBudgetConfig = {
  hourlyLimit: 1000,
  hourlyHeadroom: 100,
  authReserve: 100,
  digestHourlyCap: 300,
  digestScanLimit: 60,
  digestSendLimit: 25,
  digestMaxAttempts: 3,
  digestRetryMinutes: 15,
  digestWindowStart: "00:05",
  digestWindowEnd: "08:00",
  digestCatchupEnd: "12:00",
  digestBatchSeconds: 180,
  monthlyLimit: 25000,
  monthlyAuthReserve: 1000,
  digestEnabled: true,
};

function parseInteger(
  env: Environment,
  variable: string,
  issues: ConfigurationIssue[],
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[variable]?.trim();
  if (raw == null || raw === "") return defaultValue;
  if (!/^\d+$/.test(raw)) {
    issues.push({ variable, message: "must be a non-negative integer" });
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push({
      variable,
      message: `must be between ${minimum} and ${maximum}`,
    });
    return defaultValue;
  }
  return value;
}

function parseBoolean(
  env: Environment,
  variable: string,
  issues: ConfigurationIssue[],
  defaultValue: boolean,
): boolean {
  const raw = env[variable]?.trim().toLowerCase();
  if (raw == null || raw === "") return defaultValue;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  issues.push({ variable, message: "must be true or false" });
  return defaultValue;
}

function parseUtcMinute(
  env: Environment,
  variable: string,
  issues: ConfigurationIssue[],
  defaultValue: string,
): number | undefined {
  const raw = env[variable]?.trim() || defaultValue;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (match == null) {
    issues.push({ variable, message: "must be HH:MM in UTC" });
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseEmailBudgetConfig(
  env: Environment,
  issues: ConfigurationIssue[],
): EmailBudgetConfig {
  const hourlyLimit = parseInteger(
    env,
    "EMAIL_HOURLY_LIMIT",
    issues,
    DEFAULT_EMAIL_BUDGET.hourlyLimit,
    1,
    1_000_000,
  );
  const hourlyHeadroom = parseInteger(
    env,
    "EMAIL_HOURLY_HEADROOM",
    issues,
    DEFAULT_EMAIL_BUDGET.hourlyHeadroom,
    0,
    hourlyLimit - 1,
  );
  const authReserve = parseInteger(
    env,
    "EMAIL_AUTH_RESERVE",
    issues,
    DEFAULT_EMAIL_BUDGET.authReserve,
    1,
    hourlyLimit,
  );
  const digestHourlyCap = parseInteger(
    env,
    "EMAIL_DIGEST_HOURLY_CAP",
    issues,
    DEFAULT_EMAIL_BUDGET.digestHourlyCap,
    1,
    hourlyLimit,
  );
  const digestScanLimit = parseInteger(
    env,
    "EMAIL_DIGEST_SCAN_LIMIT",
    issues,
    DEFAULT_EMAIL_BUDGET.digestScanLimit,
    1,
    10_000,
  );
  const digestSendLimit = parseInteger(
    env,
    "EMAIL_DIGEST_SEND_LIMIT",
    issues,
    DEFAULT_EMAIL_BUDGET.digestSendLimit,
    1,
    10_000,
  );
  const digestMaxAttempts = parseInteger(
    env,
    "EMAIL_DIGEST_MAX_ATTEMPTS",
    issues,
    DEFAULT_EMAIL_BUDGET.digestMaxAttempts,
    1,
    100,
  );
  const digestRetryMinutes = parseInteger(
    env,
    "EMAIL_DIGEST_RETRY_MINUTES",
    issues,
    DEFAULT_EMAIL_BUDGET.digestRetryMinutes,
    1,
    24 * 60,
  );
  const digestWindowStart =
    env.EMAIL_DIGEST_WINDOW_START?.trim() ||
    DEFAULT_EMAIL_BUDGET.digestWindowStart;
  const digestWindowEnd =
    env.EMAIL_DIGEST_WINDOW_END?.trim() || DEFAULT_EMAIL_BUDGET.digestWindowEnd;
  const digestCatchupEnd =
    env.EMAIL_DIGEST_CATCHUP_END?.trim() ||
    DEFAULT_EMAIL_BUDGET.digestCatchupEnd;
  const digestBatchSeconds = parseInteger(
    env,
    "EMAIL_DIGEST_BATCH_SECONDS",
    issues,
    DEFAULT_EMAIL_BUDGET.digestBatchSeconds,
    1,
    299,
  );
  const monthlyLimit = parseInteger(
    env,
    "EMAIL_MONTHLY_LIMIT",
    issues,
    DEFAULT_EMAIL_BUDGET.monthlyLimit,
    1,
    100_000_000,
  );
  const monthlyAuthReserve = parseInteger(
    env,
    "EMAIL_MONTHLY_AUTH_RESERVE",
    issues,
    DEFAULT_EMAIL_BUDGET.monthlyAuthReserve,
    0,
    monthlyLimit,
  );
  const digestEnabled = parseBoolean(
    env,
    "EMAIL_DIGEST_ENABLED",
    issues,
    DEFAULT_EMAIL_BUDGET.digestEnabled,
  );

  const totalCap = hourlyLimit - hourlyHeadroom;
  if (totalCap <= authReserve) {
    issues.push({
      variable: "EMAIL_AUTH_RESERVE",
      message: "must be less than EMAIL_HOURLY_LIMIT - EMAIL_HOURLY_HEADROOM",
    });
  }
  if (digestHourlyCap > totalCap - authReserve) {
    issues.push({
      variable: "EMAIL_DIGEST_HOURLY_CAP",
      message:
        "must be at most EMAIL_HOURLY_LIMIT - EMAIL_HOURLY_HEADROOM - EMAIL_AUTH_RESERVE",
    });
  }
  const windowStart = parseUtcMinute(
    env,
    "EMAIL_DIGEST_WINDOW_START",
    issues,
    DEFAULT_EMAIL_BUDGET.digestWindowStart,
  );
  const windowEnd = parseUtcMinute(
    env,
    "EMAIL_DIGEST_WINDOW_END",
    issues,
    DEFAULT_EMAIL_BUDGET.digestWindowEnd,
  );
  const catchupEnd = parseUtcMinute(
    env,
    "EMAIL_DIGEST_CATCHUP_END",
    issues,
    DEFAULT_EMAIL_BUDGET.digestCatchupEnd,
  );
  if (windowStart != null && windowEnd != null && windowStart >= windowEnd) {
    issues.push({
      variable: "EMAIL_DIGEST_WINDOW_START",
      message: "must be earlier than EMAIL_DIGEST_WINDOW_END",
    });
  }
  if (catchupEnd != null && windowEnd != null && catchupEnd < windowEnd) {
    issues.push({
      variable: "EMAIL_DIGEST_CATCHUP_END",
      message: "must be at or after EMAIL_DIGEST_WINDOW_END",
    });
  }
  if (monthlyAuthReserve >= monthlyLimit) {
    issues.push({
      variable: "EMAIL_MONTHLY_AUTH_RESERVE",
      message: "must be less than EMAIL_MONTHLY_LIMIT",
    });
  }

  return {
    hourlyLimit,
    hourlyHeadroom,
    authReserve,
    digestHourlyCap,
    digestScanLimit,
    digestSendLimit,
    digestMaxAttempts,
    digestRetryMinutes,
    digestWindowStart,
    digestWindowEnd,
    digestCatchupEnd,
    digestBatchSeconds,
    monthlyLimit,
    monthlyAuthReserve,
    digestEnabled,
  };
}

function parseDatabaseConfig(
  env: Environment,
  issues: ConfigurationIssue[],
): DatabaseConfig | undefined {
  const url = nonEmpty(env, "DATABASE_URL", issues);
  return url == null ? undefined : { url };
}

export function loadDatabaseConfig(env: Environment): DatabaseConfig {
  const issues: ConfigurationIssue[] = [];
  const config = parseDatabaseConfig(env, issues);
  if (config == null) throw new ConfigurationError(issues);
  return config;
}

function parseUrl(
  value: string | undefined,
  variable: string,
  issues: ConfigurationIssue[],
  protocols?: readonly string[],
): URL | undefined {
  if (value == null) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ variable, message: "must be a valid URL" });
    return undefined;
  }
  if (protocols != null && !protocols.includes(url.protocol)) {
    issues.push({
      variable,
      message: `must use ${protocols.join(" or ")}`,
    });
    return undefined;
  }
  return url;
}

function parseAccountCreationConfig(
  env: Environment,
  issues: ConfigurationIssue[],
): Partial<AccountCreationConfig> {
  const origin = parseUrl(nonEmpty(env, "ORIGIN", issues), "ORIGIN", issues, [
    "http:",
    "https:",
  ]);
  const kvUrl = parseUrl(nonEmpty(env, "KV_URL", issues), "KV_URL", issues, [
    "file:",
    "redis:",
    "rediss:",
  ]);
  return {
    ...(origin == null ? {} : { origin }),
    ...(kvUrl == null ? {} : { kv: { url: kvUrl } }),
  };
}

export function loadAccountCreationConfig(
  env: Environment,
): AccountCreationConfig {
  const issues: ConfigurationIssue[] = [];
  const config = parseAccountCreationConfig(env, issues);
  if (issues.length > 0 || config.origin == null || config.kv == null) {
    throw new ConfigurationError(issues);
  }
  return { origin: config.origin, kv: config.kv };
}

export function loadServerConfig(env: Environment): ServerConfig {
  const issues: ConfigurationIssue[] = [];
  const database = parseDatabaseConfig(env, issues);
  const { origin, kv } = parseAccountCreationConfig(env, issues);

  const driver = nonEmpty(env, "DRIVE_DISK", issues);
  let storage: StorageConfig | undefined;
  if (driver === "fs") {
    const location = nonEmpty(env, "FS_LOCATION", issues);
    if (location != null) storage = { driver, location };
  } else if (driver === "s3") {
    const accessKeyId = nonEmpty(env, "AWS_ACCESS_KEY_ID", issues);
    const secretAccessKey = nonEmpty(env, "AWS_SECRET_ACCESS_KEY", issues);
    const region = nonEmpty(env, "AWS_REGION", issues);
    const bucket = nonEmpty(env, "S3_BUCKET", issues);
    if (
      accessKeyId != null &&
      secretAccessKey != null &&
      region != null &&
      bucket != null
    ) {
      storage = {
        driver,
        accessKeyId,
        secretAccessKey,
        region,
        bucket,
        ...(env.S3_ENDPOINT == null ? {} : { endpoint: env.S3_ENDPOINT }),
        ...(env.S3_CDN_URL == null ? {} : { cdnUrl: env.S3_CDN_URL }),
      };
    }
  } else if (driver != null) {
    issues.push({ variable: "DRIVE_DISK", message: "must be fs or s3" });
  }

  const configuredFrom = env.EMAIL_FROM?.trim();
  const defaultFrom = `noreply@${origin?.hostname ?? "localhost"}`;
  const mode = env.MODE ?? "production";
  const mailerooSelected =
    env.MAILEROO_KEY != null && env.MAILEROO_KEY.trim() !== "";
  let email: EmailConfig | undefined;
  if (env.CI?.toLowerCase() === "true") {
    email = {
      transport: "mock",
      from: configuredFrom || defaultFrom,
      reason: "ci",
    };
  } else if (
    !mailerooSelected &&
    (mode === "development" || mode === "test" || mode === "build")
  ) {
    email = {
      transport: "logtape",
      from: configuredFrom || defaultFrom,
    };
  } else {
    const from = configuredFrom;
    if (from == null || from === "") {
      issues.push({ variable: "EMAIL_FROM", message: "is required" });
    }
    const apiKey = nonEmpty(env, "MAILEROO_KEY", issues);
    if (from != null && from !== "" && apiKey != null) {
      email = { transport: "maileroo", from, apiKey };
    }
  }

  const emailBudget = parseEmailBudgetConfig(env, issues);

  if (
    issues.length > 0 ||
    database == null ||
    origin == null ||
    kv == null ||
    storage == null ||
    email == null
  ) {
    throw new ConfigurationError(issues);
  }
  return {
    database,
    origin,
    kv,
    storage,
    email,
    emailBudget,
    ai: {
      altTextModel: env.AI_ALT_TEXT_MODEL ?? "gemini-3.1-flash-lite",
      summarizerModel: env.AI_SUMMARIZER_MODEL ?? "gemini-3.8-flash",
      translatorModel: env.AI_TRANSLATOR_MODEL ?? "gemini-3.8-flash",
      moderationModel: env.AI_MODERATION_MODEL ?? "claude-sonnet-5",
    },
    behindProxy: env.BEHIND_PROXY?.toLowerCase() === "true",
    mode,
  };
}

function requireProcessSafeSharedKv(config: ServerConfig): ServerConfig {
  if (
    config.kv.url.protocol !== "redis:" &&
    config.kv.url.protocol !== "rediss:"
  ) {
    throw new ConfigurationError([
      {
        variable: "KV_URL",
        message: "must use redis for standalone GraphQL services",
      },
    ]);
  }
  return config;
}

export function loadStandaloneServerConfig(env: Environment): ServerConfig {
  return requireProcessSafeSharedKv(loadServerConfig(env));
}

export interface GraphqlApiConfigOptions {
  readonly allowFileKv?: boolean;
}

export function loadGraphqlApiConfig(
  env: Environment,
  options: GraphqlApiConfigOptions = {},
): ServerConfig {
  const config = loadServerConfig(env);
  return options.allowFileKv && config.mode === "development"
    ? config
    : requireProcessSafeSharedKv(config);
}

export function getProcessEnvironment(): Environment {
  return { ...process.env };
}

/**
 * @deprecated Use `getProcessEnvironment()` for runtime-neutral configuration.
 */
export const getDenoEnvironment = getProcessEnvironment;
import process from "node:process";

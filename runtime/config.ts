export interface Environment {
  readonly [variable: string]: string | undefined;
}

export interface ConfigurationIssue {
  readonly variable: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly ConfigurationIssue[]) {
    super(
      `Invalid server configuration:\n${
        issues.map(({ variable, message }) => `- ${variable}: ${message}`).join(
          "\n",
        )
      }`,
    );
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
    readonly reason: "ci" | "mailgun-unconfigured";
  }
  | {
    readonly transport: "mailgun";
    readonly from: string;
    readonly apiKey: string;
    readonly domain: string;
    readonly region: "eu" | "us";
  };

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
  const origin = parseUrl(
    nonEmpty(env, "ORIGIN", issues),
    "ORIGIN",
    issues,
    ["http:", "https:"],
  );
  const kvUrl = parseUrl(
    nonEmpty(env, "KV_URL", issues),
    "KV_URL",
    issues,
    ["file:", "redis:"],
  );
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
      accessKeyId != null && secretAccessKey != null && region != null &&
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

  const configuredFrom = (env.EMAIL_FROM ?? env.MAILGUN_FROM)?.trim();
  const defaultFrom = `noreply@${origin?.hostname ?? "localhost"}`;
  const mode = env.MODE ?? "production";
  const mailgunSelected = [
    env.MAILGUN_KEY,
    env.MAILGUN_DOMAIN,
  ].some((value) => value != null && value.trim() !== "");
  let email: EmailConfig | undefined;
  if (env.CI?.toLowerCase() === "true") {
    email = {
      transport: "mock",
      from: configuredFrom || defaultFrom,
      reason: "ci",
    };
  } else if (
    !mailgunSelected &&
    (mode === "development" || mode === "test" || mode === "build")
  ) {
    email = {
      transport: "mock",
      from: configuredFrom || defaultFrom,
      reason: "mailgun-unconfigured",
    };
  } else {
    const from = configuredFrom;
    if (from == null || from === "") {
      issues.push({
        variable: "EMAIL_FROM",
        message: "EMAIL_FROM or MAILGUN_FROM is required",
      });
    }
    const apiKey = nonEmpty(env, "MAILGUN_KEY", issues);
    const domain = nonEmpty(env, "MAILGUN_DOMAIN", issues);
    const regionValue = nonEmpty(env, "MAILGUN_REGION", issues);
    const region = regionValue === "eu" || regionValue === "us"
      ? regionValue
      : undefined;
    if (regionValue != null && region == null) {
      issues.push({
        variable: "MAILGUN_REGION",
        message: "must be eu or us",
      });
    }
    if (
      from != null && from !== "" && apiKey != null && domain != null &&
      region != null
    ) {
      email = {
        transport: "mailgun",
        from,
        apiKey,
        domain,
        region,
      };
    }
  }

  if (
    issues.length > 0 || database == null || origin == null ||
    kv == null || storage == null || email == null
  ) {
    throw new ConfigurationError(issues);
  }
  return {
    database,
    origin,
    kv,
    storage,
    email,
    ai: {
      altTextModel: env.AI_ALT_TEXT_MODEL ?? "gemini-3.1-flash-lite",
      summarizerModel: env.AI_SUMMARIZER_MODEL ?? "gemini-3.5-flash",
      translatorModel: env.AI_TRANSLATOR_MODEL ?? "claude-sonnet-5",
      moderationModel: env.AI_MODERATION_MODEL ?? "claude-sonnet-5",
    },
    behindProxy: env.BEHIND_PROXY?.toLowerCase() === "true",
    mode,
  };
}

export function loadStandaloneServerConfig(env: Environment): ServerConfig {
  const config = loadServerConfig(env);
  if (config.kv.url.protocol !== "redis:") {
    throw new ConfigurationError([{
      variable: "KV_URL",
      message: "must use redis for standalone GraphQL services",
    }]);
  }
  return config;
}

export function getDenoEnvironment(): Environment {
  return Deno.env.toObject();
}

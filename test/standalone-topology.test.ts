import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readTextFile = (path: string | URL) => readFile(path, "utf8");

test("standalone services share the application media root", async () => {
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );
  const tasks = await readTextFile(new URL("../mise.toml", import.meta.url));

  assertStringIncludes(compose, "FS_LOCATION: ./media");
  assertStringIncludes(compose, "- ./media:/app/media:z");
  assertStringIncludes(
    compose,
    'command: sh -c "mise run migrate:media && mise run migrate"',
  );
  assertStringIncludes(tasks, '[tasks."migrate:media"]');
  assertStringIncludes(tasks, 'run = "node scripts/migrate-media.ts"');
  assert(!compose.includes("FS_LOCATION: ${FS_LOCATION"));
  assert(!compose.includes("/app/web"));
});

test("Codespaces exposes a single canonical gateway origin", async () => {
  const configuration = await readTextFile(
    new URL("../.devcontainer/codespaces/devcontainer.json", import.meta.url),
  );
  const overlay = await readTextFile(
    new URL("../.devcontainer/codespaces/docker-compose.yml", import.meta.url),
  );
  const gateway = await readTextFile(
    new URL("../Caddyfile.codespaces", import.meta.url),
  );

  assertStringIncludes(configuration, '"../../docker-compose.yml"');
  assertStringIncludes(configuration, '"docker-compose.yml"');
  assertStringIncludes(
    configuration,
    '"ORIGIN": "https://${localEnv:CODESPACE_NAME}-8000.',
  );
  assert(!configuration.includes("-3000."));
  assert(!configuration.includes("-8080."));
  assertStringIncludes(
    overlay,
    "ORIGIN: https://${CODESPACE_NAME}-8000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}",
  );
  assertStringIncludes(gateway, "reverse_proxy graphql:8080");
  assertStringIncludes(gateway, "reverse_proxy web-next:3000");
});

test("development gateway preserves trusted tunnel metadata", async () => {
  const gateway = await readTextFile(
    new URL("../Caddyfile.dev", import.meta.url),
  );

  assertStringIncludes(gateway, "trusted_proxies static private_ranges");
  assertStringIncludes(gateway, "trusted_proxies_strict");
  assertStringIncludes(gateway, "header_up X-Forwarded-For {client_ip}");
});

test("shared production image delegates role health checks", async () => {
  const dockerfile = await readTextFile(
    new URL("../Dockerfile", import.meta.url),
  );
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );

  assertStringIncludes(dockerfile, "HEALTHCHECK NONE");
  for (const role of ["graphql", "graphql-worker", "web-next"]) {
    assertStringIncludes(compose, `prod:hc:${role}`);
  }
});

test("container dependency layers include the GraphQL package manifest", async () => {
  const production = await readTextFile(
    new URL("../Dockerfile", import.meta.url),
  );
  const development = await readTextFile(
    new URL("../Dockerfile.dev", import.meta.url),
  );
  const manifestCopy = "COPY graphql/package.json /app/graphql/package.json";

  assertEquals(production.split(manifestCopy).length - 1, 2);
  assertStringIncludes(development, manifestCopy);
});

test("Compose services ignore the bind-mounted host dotenv file", async () => {
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );
  const application = compose.match(/^x-application:[\s\S]*?\nservices:/)?.[0];
  const webNext = compose.match(/^ {2}web-next:\n[\s\S]*?^ {2}gateway:/m)?.[0];

  assert(application != null);
  assertStringIncludes(application, 'MISE_NO_ENV: "1"');
  assertStringIncludes(application, "ORIGIN: ${ORIGIN:-http://localhost:8000}");
  assert(webNext != null);
  assertStringIncludes(webNext, 'MISE_NO_ENV: "1"');
  assertStringIncludes(webNext, "ORIGIN: ${ORIGIN:-http://localhost:8000}");
});

test("Compose forwards dotenv runtime options before mise starts", async () => {
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );
  const application = compose.match(/^x-application:[\s\S]*?\nservices:/)?.[0];

  assert(application != null);
  assertStringIncludes(application, "env_file:");
  assertStringIncludes(application, "path: .env");
  assertStringIncludes(application, "required: false");
  assertStringIncludes(
    application,
    "DATABASE_URL: postgresql://postgres:password@db:5432/hackerspub",
  );
  assertStringIncludes(application, "KV_URL: redis://redis:6379/0");
});

test("Compose preserves the configured Mailgun sender", async () => {
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );

  assertStringIncludes(
    compose,
    "EMAIL_FROM: ${EMAIL_FROM:-${MAILGUN_FROM:-admin@example.com}}",
  );
});

test("file KV is limited to API-only development", async () => {
  const sample = await readTextFile(new URL("../.env.sample", import.meta.url));
  const contributing = await readTextFile(
    new URL("../CONTRIBUTING.md", import.meta.url),
  );
  const main = await readTextFile(
    new URL("../graphql/main.ts", import.meta.url),
  );
  const worker = await readTextFile(
    new URL("../graphql/worker.ts", import.meta.url),
  );
  const tasks = await readTextFile(
    new URL("../graphql/deno.json", import.meta.url),
  );
  const launch = JSON.parse(
    await readTextFile(new URL("../.vscode/launch.json", import.meta.url)),
  ) as {
    configurations: { name: string; args?: string[] }[];
  };

  assertStringIncludes(sample, "KV_URL=redis://localhost:6379/0");
  assertStringIncludes(contributing, "`KV_URL=redis://localhost:6379/0`");
  const redisPrerequisite = contributing.indexOf(" -  [Redis]");
  const firstKvCommand = contributing.indexOf("mise run addaccount");
  assert(redisPrerequisite >= 0);
  assert(redisPrerequisite < firstKvCommand);
  assertStringIncludes(contributing, "redis-cli ping");
  assertStringIncludes(main, "loadGraphqlApiConfig");
  assertStringIncludes(main, 'Deno.args.includes("--allow-file-kv")');
  assertStringIncludes(worker, "loadStandaloneServerConfig");
  assertStringIncludes(tasks, "main.ts --allow-file-kv");
  assertEquals(
    launch.configurations.find(({ name }) => name === "GraphQL API")?.args,
    ["--allow-file-kv"],
  );
  assertStringIncludes(
    tasks,
    '"start": "deno run -A --unstable-otel --unstable-cron --env-file=../.env main.ts"',
  );
});

test("standalone smoke owns a shared Redis configuration", async () => {
  const smoke = await readTextFile(
    new URL("../scripts/smoke-standalone.ts", import.meta.url),
  );

  assertStringIncludes(smoke, 'Deno.env.get("STANDALONE_SMOKE_KV_URL")');
  assertStringIncludes(smoke, '"redis://127.0.0.1:6379/0"');
  assertStringIncludes(smoke, "{ KV_URL: standaloneKvUrl }");
  assert(!smoke.includes('new Deno.Command("mise"'));
});

test("web-next proxies canonical filesystem upload URLs", async () => {
  const route = await readTextFile(
    new URL("../web-next/src/routes/medium-uploads.ts", import.meta.url),
  );
  const middleware = await readTextFile(
    new URL("../web-next/src/middleware.ts", import.meta.url),
  );

  assertStringIncludes(route, "createMediumUploadProxyRequest");
  assertStringIncludes(route, "export async function PUT");
  assertStringIncludes(middleware, "createMediumUploadPreflightResponse");
  assertStringIncludes(middleware, 'url.pathname === "/medium-uploads"');
});

test("standalone services preserve the compatible signature first knock", async () => {
  const api = await readTextFile(
    new URL("../graphql/main.ts", import.meta.url),
  );
  const worker = await readTextFile(
    new URL("../graphql/worker.ts", import.meta.url),
  );
  const firstKnock = 'firstKnock: "draft-cavage-http-signatures-12"';

  assertStringIncludes(api, firstKnock);
  assertStringIncludes(worker, firstKnock);
});

test("container builds omit the removed Fresh application", async () => {
  const dockerfile = await readTextFile(
    new URL("../Dockerfile", import.meta.url),
  );
  const developmentDockerfile = await readTextFile(
    new URL("../Dockerfile.dev", import.meta.url),
  );
  const compose = await readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );

  for (const source of [dockerfile, developmentDockerfile]) {
    assert(!source.includes("web/deno.json"));
    assert(!source.includes("web/fonts"));
    assert(!/mise run build:web(?:\s|$)/.test(source));
    assert(!source.includes("hackerspub-build-kv"));
  }
  assertStringIncludes(dockerfile, "mise run build:web-next");
  assert(!/^ {2}app:/m.test(compose));
  assert(!compose.includes('"8001:8000"'));
});

test("development image includes the runtime workspace metadata", async () => {
  const dockerfile = await readTextFile(
    new URL("../Dockerfile.dev", import.meta.url),
  );

  assertStringIncludes(
    dockerfile,
    "COPY runtime/deno.json /app/runtime/deno.json",
  );
  assertStringIncludes(
    dockerfile,
    "COPY runtime/package.json /app/runtime/package.json",
  );
});

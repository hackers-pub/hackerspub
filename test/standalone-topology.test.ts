import { assert, assertStringIncludes } from "@std/assert";

Deno.test("standalone services share the legacy-compatible media root", async () => {
  const compose = await Deno.readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );

  assertStringIncludes(compose, "FS_LOCATION: ./media");
  assertStringIncludes(compose, "- ./web/media:/app/web/media:z");
  assert(!compose.includes("FS_LOCATION: ${FS_LOCATION"));
});

Deno.test("Codespaces exposes a single canonical gateway origin", async () => {
  const configuration = await Deno.readTextFile(
    new URL("../.devcontainer/codespaces/devcontainer.json", import.meta.url),
  );
  const overlay = await Deno.readTextFile(
    new URL(
      "../.devcontainer/codespaces/docker-compose.yml",
      import.meta.url,
    ),
  );
  const gateway = await Deno.readTextFile(
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

Deno.test("development gateway preserves trusted tunnel metadata", async () => {
  const gateway = await Deno.readTextFile(
    new URL("../Caddyfile.dev", import.meta.url),
  );

  assertStringIncludes(gateway, "trusted_proxies static private_ranges");
  assertStringIncludes(gateway, "trusted_proxies_strict");
  assertStringIncludes(gateway, "header_up X-Forwarded-For {client_ip}");
});

Deno.test("shared production image delegates role health checks", async () => {
  const dockerfile = await Deno.readTextFile(
    new URL("../Dockerfile", import.meta.url),
  );
  const compose = await Deno.readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );

  assertStringIncludes(dockerfile, "HEALTHCHECK NONE");
  for (const role of ["graphql", "graphql-worker", "web-next"]) {
    assertStringIncludes(compose, `prod:hc:${role}`);
  }
});

Deno.test("Compose services ignore the bind-mounted host dotenv file", async () => {
  const compose = await Deno.readTextFile(
    new URL("../docker-compose.yml", import.meta.url),
  );
  const application = compose.match(/^x-application:[\s\S]*?\nservices:/)?.[0];
  const webNext = compose.match(/^ {2}web-next:\n[\s\S]*?^ {2}gateway:/m)?.[0];

  assert(application != null);
  assertStringIncludes(application, 'MISE_NO_ENV: "1"');
  assert(webNext != null);
  assertStringIncludes(webNext, 'MISE_NO_ENV: "1"');
});

Deno.test("Compose forwards dotenv runtime options before mise starts", async () => {
  const compose = await Deno.readTextFile(
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

Deno.test("standalone worker preserves the legacy signature first knock", async () => {
  const legacy = await Deno.readTextFile(
    new URL("../web/main.ts", import.meta.url),
  );
  const worker = await Deno.readTextFile(
    new URL("../graphql/worker.ts", import.meta.url),
  );
  const firstKnock = 'firstKnock: "draft-cavage-http-signatures-12"';

  assertStringIncludes(legacy, firstKnock);
  assertStringIncludes(worker, firstKnock);
});

Deno.test("development image includes the runtime workspace metadata", async () => {
  const dockerfile = await Deno.readTextFile(
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

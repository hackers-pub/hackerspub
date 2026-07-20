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

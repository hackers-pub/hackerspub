/** Real Caddy routing/reload; controlled backends, not application interoperability. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address != null && typeof address !== "string");
  return address.port;
}
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await setTimeout(10);
  }
  throw new Error("Proxy fixture did not become ready");
}

test(
  "both Caddy configurations preserve association exceptions and reload rollback under protocol load",
  {
    timeout: 30000,
  },
  async (t) => {
    try {
      await execute("caddy", ["version"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("Caddy is not installed; real proxy routing was not exercised");
        return;
      }
      throw error;
    }
    const directory = await mkdtemp(join(tmpdir(), "hackerspub-proxy-test-"));
    const servers: Server[] = [];
    const children: ChildProcess[] = [];
    let active = 0;
    let peak = 0;
    const backend = async (name: string): Promise<string> => {
      const server = createServer((request, response) => {
        if (name === "protocol" && request.url === "/ap/slow") {
          if (active >= 2) {
            response.writeHead(503).end();
            return;
          }
          active++;
          peak = Math.max(peak, active);
          globalThis.setTimeout(() => {
            active--;
            response.end(name);
          }, 150);
        } else response.end(name);
      });
      servers.push(server);
      return `127.0.0.1:${await listen(server)}`;
    };
    try {
      const upstreams: Record<string, string> = {
        "graphql:8080": await backend("interactive"),
        "protocol:8081": await backend("protocol"),
        "web-next:3000": await backend("web"),
      };
      for (const name of ["dev", "codespaces"]) {
        const { stdout } = await execute("caddy", [
          "adapt",
          "--config",
          `Caddyfile.${name}`,
          "--adapter",
          "caddyfile",
        ]);
        const config = JSON.parse(stdout);
        const port = await freePort();
        const adminPort = await freePort();
        config.admin = {
          listen: `127.0.0.1:${adminPort}`,
          config: { persist: false },
        };
        const server = Object.values(config.apps.http.servers)[0] as {
          listen: string[];
        };
        server.listen = [`127.0.0.1:${port}`];
        function route(value: unknown, rollback = false): void {
          if (value == null || typeof value !== "object") return;
          const node = value as Record<string, unknown>;
          if (node.handler === "reverse_proxy") {
            for (const upstream of node.upstreams as { dial: string }[]) {
              if (rollback && upstream.dial === upstreams["protocol:8081"])
                upstream.dial = upstreams["graphql:8080"];
              else if (!rollback) {
                assert.ok(upstreams[upstream.dial], upstream.dial);
                upstream.dial = upstreams[upstream.dial];
              }
            }
          }
          for (const child of Object.values(node)) {
            if (Array.isArray(child))
              for (const item of child) route(item, rollback);
            else route(child, rollback);
          }
        }
        route(config);
        const file = join(directory, `${name}.json`);
        await writeFile(file, JSON.stringify(config));
        const child = spawn("caddy", ["run", "--config", file], {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let output = "";
        child.stderr.on("data", (chunk) => {
          output = (output + String(chunk)).slice(-8000);
        });
        const origin = `http://127.0.0.1:${port}`;
        await eventually(async () => {
          assert.equal(child.exitCode, null, output);
          try {
            return (
              await fetch(`${origin}/search`, {
                headers: { connection: "close" },
              })
            ).ok;
          } catch {
            return false;
          }
        });
        const probe = async (path: string, expected: string, status = 200) => {
          const response = await fetch(`${origin}${path}`, {
            headers: { connection: "close" },
          });
          assert.equal(response.status, status, `${name} ${path}`);
          assert.equal(await response.text(), expected, `${name} ${path}`);
        };
        for (const path of [
          "/.well-known/assetlinks.json",
          "/.well-known/apple-app-site-association",
          "/graphql",
          "/media/file",
        ])
          await probe(path, "interactive");
        for (const path of [
          "/.well-known/webfinger?resource=acct:test@example.com",
          "/.well-known/nodeinfo",
          "/ap/actors/test",
          "/nodeinfo/2.1",
        ])
          await probe(path, "protocol");
        await probe("/health", "", 404);
        let running = true;
        let interrupted = 0;
        let rollback = false;
        let combinedResponses = 0;
        const load = Promise.all(
          Array.from({ length: 4 }, async () => {
            while (running) {
              try {
                const response = await fetch(`${origin}/ap/slow`, {
                  headers: { connection: "close" },
                });
                assert.ok([200, 503].includes(response.status));
                const body = await response.text();
                if (rollback && body === "interactive") combinedResponses++;
                if (response.status === 503) await setTimeout(5);
              } catch (error) {
                // Reload can close an old HTTP socket. Count that unknown outcome
                // explicitly; successful post-reload requests establish recovery.
                const code = (error as { cause?: { code?: string } }).cause
                  ?.code;
                if (
                  !rollback ||
                  (code !== "UND_ERR_SOCKET" && code !== "ECONNRESET")
                )
                  throw error;
                interrupted++;
              }
            }
          }),
        );
        void load.catch(() => {});
        try {
          await eventually(async () => active === 2);
          await probe("/graphql", "interactive");
          // Model the documented rollback: a ready combined API takes protocol
          // paths while existing requests are still draining on the old backend.
          rollback = true;
          route(config, true);
          const response = await fetch(`http://127.0.0.1:${adminPort}/load`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(config),
          });
          assert.equal(response.status, 200, await response.text());
          await probe(
            "/.well-known/webfinger?resource=acct:test@example.com",
            "interactive",
          );
          await eventually(async () => combinedResponses >= 4);
          assert.ok(
            interrupted <= 4,
            `unexpected rollback interruptions: ${interrupted}`,
          );
          t.diagnostic(
            `${name}: ${interrupted} protocol requests interrupted during reload; ${combinedResponses} resumed on combined backend`,
          );
          await probe("/ap/actors/test", "interactive");
          await probe("/.well-known/assetlinks.json", "interactive");
          await probe("/graphql", "interactive");
        } finally {
          running = false;
          await load;
        }
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const [code, signal] = await exited;
        assert.equal(signal, null, output);
        assert.equal(code, 0, output);
      }
      assert.equal(peak, 2);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode != null || child.signalCode != null) return;
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }),
      );
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error == null ? resolve() : reject(error),
              );
            }),
        ),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

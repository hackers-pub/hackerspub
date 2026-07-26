import { assert } from "@std/assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The `hackerspub-runtime/no-deno-globals` lint rule guards TypeScript, but
// oxlint never sees the files that decide what actually runs.  A reinstated
// `deno` tool pin, a `shell = "deno eval"` task, a `DENO_DIR` environment
// variable, or a resurrected `deno.json` would sail past every other gate.
const repositoryRoot = new URL("../", import.meta.url);

// Underscores are regex word characters, so `\bdeno\b` misses `DENO_DIR`.
// Treat anything other than a letter or digit as a boundary.
const DENO = /(?:^|[^A-Za-z0-9])deno(?:$|[^A-Za-z0-9])/i;

// The rule that enforces all of this has to name what it forbids.  Only that
// exact token is excused, not the rest of the line it sits on.
const GUARD = /no-deno-globals/g;

const CONFIGURATION_PATTERNS = [
  /^\.env\.[^/]+$/,
  /^\.github\/workflows\/[^/]+$/,
  /^\.devcontainer\/.+$/,
  /^\.vscode\/[^/]+\.json$/,
  /^\.zed\/[^/]+\.json$/,
  /^(?:.+\/)?Dockerfile(?:\..+)?$/,
  /^(?:.+\/)?\.dockerignore$/,
  /^(?:.+\/)?docker-compose(?:\..+)?\.ya?ml$/,
  /^(?:.+\/)?compose(?:\..+)?\.ya?ml$/,
  /^(?:.+\/)?package\.json$/,
  /^(?:.+\/)?tsconfig(?:\..+)?\.json$/,
  /^(?:.+\/)?wrangler\.toml$/,
  /^\.oxfmtrc\.json$/,
  /^oxlint\.config\.ts$/,
  /^mise\.toml$/,
  /^pnpm-workspace\.yaml$/,
];

// Names that must never come back at all, wherever they appear.
const FORBIDDEN_FILENAMES = /(?:^|\/)deno\.(?:json|jsonc|lock)$/;

function listTrackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: fileURLToPath(repositoryRoot),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error != null) throw result.error;
  assert(
    result.status === 0,
    `git ls-files failed: ${result.stderr || result.status}`,
  );
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

test("no Deno configuration file is tracked", () => {
  const offenders = listTrackedFiles().filter((path) =>
    FORBIDDEN_FILENAMES.test(path),
  );
  assert(
    offenders.length < 1,
    `Deno configuration is back in the repository:\n` +
      offenders.map((path) => `  ${path}`).join("\n"),
  );
});

test("build and deployment configuration does not mention Deno", async () => {
  const configurationFiles = listTrackedFiles().filter(
    (path) =>
      !path.startsWith("node_modules/") &&
      CONFIGURATION_PATTERNS.some((pattern) => pattern.test(path)),
  );
  // A typo in the patterns above would quietly reduce this to nothing, which
  // would look like a pass.
  assert(configurationFiles.length > 15);

  const offenders: string[] = [];
  for (const file of configurationFiles) {
    const source = await readFile(new URL(file, repositoryRoot), "utf8");
    source.split("\n").forEach((line, index) => {
      if (DENO.test(line.replace(GUARD, ""))) {
        offenders.push(`  ${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert(
    offenders.length < 1,
    `Build configuration still refers to Deno:\n${offenders.join("\n")}`,
  );
});

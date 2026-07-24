import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface OxlintTestDiagnostic {
  readonly id: string;
  readonly fix: readonly unknown[];
  readonly fixedSource: string;
}

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configPath = fileURLToPath(
  new URL("../../oxlint.config.ts", import.meta.url),
);
const oxlintPath = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxlint.cmd" : "oxlint",
);

export function lintWithOxlint(
  ruleId: string,
  source: string,
): OxlintTestDiagnostic[] {
  const directory = mkdtempSync(join(tmpdir(), "hackerspub-oxlint-"));
  const fixture = join(directory, "fixture.test.tsx");
  try {
    writeFileSync(fixture, source);
    const result = runOxlint([
      "--config",
      configPath,
      "--format",
      "json",
      fixture,
    ]);
    const parsed = JSON.parse(result.stdout) as {
      diagnostics: { code: string }[];
    };
    const diagnostics = parsed.diagnostics.filter(
      ({ code }) => normalizeRuleId(code) === ruleId,
    );
    if (diagnostics.length < 1) return [];

    runOxlint(["--config", configPath, "--fix", fixture]);
    const fixedSource = readFileSync(fixture, "utf8");
    const fix = fixedSource === source ? [] : [{}];
    return diagnostics.map(() => ({ id: ruleId, fix, fixedSource }));
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runOxlint(args: readonly string[]) {
  const result = spawnSync(oxlintPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0 && result.stdout.trim() === "") {
    throw new Error(result.stderr || `Oxlint exited with ${result.status}.`);
  }
  return result;
}

function normalizeRuleId(code: string): string {
  const match = /^(.*)\(([^()]+)\)$/.exec(code);
  return match == null ? code : `${match[1]}/${match[2]}`;
}

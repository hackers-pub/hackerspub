import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";

interface WorkspaceConfiguration {
  readonly catalog?: unknown;
}

interface DenoConfiguration {
  imports?: Record<string, string>;
  [key: string]: unknown;
}

const repositoryRoot = new URL("../", import.meta.url);
const workspaceUrl = new URL("pnpm-workspace.yaml", repositoryRoot);
const denoConfigUrl = new URL("deno.json", repositoryRoot);

export function toDenoImport(
  packageName: string,
  catalogValue: string,
): string {
  if (catalogValue.startsWith("jsr:")) {
    const specifier = catalogValue.slice("jsr:".length);
    if (specifier.startsWith("@") || specifier.startsWith(`${packageName}@`)) {
      return catalogValue;
    }
    return `jsr:${packageName}@${specifier}`;
  }
  if (catalogValue.startsWith("npm:")) return catalogValue;
  return `npm:${packageName}@${catalogValue}`;
}

export function buildDenoImports(
  catalog: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(catalog).toSorted().map((packageName) => {
      const value = catalog[packageName];
      if (typeof value !== "string" || value.length < 1) {
        throw new TypeError(
          `Catalog entry ${JSON.stringify(packageName)} must be a string.`,
        );
      }
      return [packageName, toDenoImport(packageName, value)];
    }),
  );
}

export function validateCatalog(
  catalog: unknown,
): asserts catalog is Record<string, unknown> {
  if (
    catalog == null || typeof catalog !== "object" || Array.isArray(catalog)
  ) {
    throw new TypeError(
      "pnpm-workspace.yaml must define a catalog mapping.",
    );
  }
}

export function renderDenoConfig(
  source: string,
  catalog: Record<string, unknown>,
): string {
  const configuration = JSON.parse(source) as DenoConfiguration;
  configuration.imports = buildDenoImports(catalog);
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv[2] === "--check";
  if (process.argv.length > (check ? 3 : 2)) {
    throw new TypeError(
      "Usage: node scripts/sync-deno-imports.ts [--check]",
    );
  }

  const workspace = parse(
    await readFile(workspaceUrl, "utf8"),
  ) as WorkspaceConfiguration;
  validateCatalog(workspace.catalog);

  const current = await readFile(denoConfigUrl, "utf8");
  const expected = renderDenoConfig(current, workspace.catalog);
  if (check) {
    if (current !== expected) {
      console.error(
        "deno.json imports are out of date. Run `mise run deps:sync`.",
      );
      process.exitCode = 1;
    }
    return;
  }
  if (current !== expected) await writeFile(denoConfigUrl, expected);
}

if (import.meta.main) await main();

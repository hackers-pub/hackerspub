import assert from "node:assert";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface PackageManifest {
  readonly name: string;
  readonly exports?: string | Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface DenoInfoModule {
  readonly local?: string;
  readonly error?: string;
  readonly dependencies?: readonly { readonly specifier: string }[];
}

const repositoryRoot = new URL("../", import.meta.url);
const corePackageDirectories = [
  "ai",
  "federation",
  "graphql",
  "models",
  "runtime",
] as const;
const additionalProductionEntrypoints: Readonly<
  Record<string, readonly string[]>
> = {
  graphql: ["./main.ts", "./worker.ts"],
};

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

async function getWorkspaceDirectories(): Promise<string[]> {
  const workspace = parse(
    await Deno.readTextFile(
      new URL("pnpm-workspace.yaml", repositoryRoot),
    ),
  ) as { packages?: unknown };
  assert.ok(Array.isArray(workspace.packages));
  assert.ok(
    workspace.packages.every((directory) => typeof directory === "string"),
  );
  return workspace.packages;
}

function getPackageName(specifier: string): string | undefined {
  const normalized = specifier.replace(/^(?:jsr|npm):/, "");
  if (
    normalized.startsWith(".") || normalized.startsWith("/") ||
    normalized.startsWith("data:") || normalized.startsWith("file:") ||
    normalized.startsWith("http:") || normalized.startsWith("https:") ||
    normalized.startsWith("node:") || normalized.startsWith("#") ||
    normalized.startsWith("~") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) {
    return undefined;
  }
  const parts = normalized.split("/");
  return normalized.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function listSourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  async function visit(url: URL): Promise<void> {
    for await (const entry of Deno.readDir(url)) {
      if (
        entry.name === "node_modules" || entry.name === ".output" ||
        entry.name === ".vinxi" || entry.name === ".nitro" ||
        entry.name === "dist" || entry.name === "storybook-static"
      ) {
        continue;
      }
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), url);
      if (entry.isDirectory) {
        await visit(child);
      } else if (entry.isFile && /\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push(child);
      }
    }
  }
  await visit(directory);
  return files;
}

async function getDirectImports(files: readonly URL[]): Promise<string[]> {
  const imports = new Set<string>();
  const staticImportPattern =
    /^\s*(?:import|export)\s+(?:(?:type\s+)?[^"'();]*?\s+from\s+)?(["'])([^"']+)\1/gm;
  const dynamicImportPattern = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (
      const pattern of [staticImportPattern, dynamicImportPattern] as const
    ) {
      for (const match of source.matchAll(pattern)) {
        const packageName = getPackageName(match[2]);
        if (packageName != null) imports.add(packageName);
      }
    }
  }
  return [...imports].toSorted();
}

test("getPackageName() normalizes registry prefixes", () => {
  assert.equal(getPackageName("npm:postgres"), "postgres");
  assert.equal(getPackageName("jsr:@std/assert"), "@std/assert");
  assert.equal(getPackageName("http://example.com/mod.ts"), undefined);
  assert.equal(getPackageName("https://example.com/mod.ts"), undefined);
});

async function getModuleGraph(
  entrypoints: readonly URL[],
): Promise<DenoInfoModule[]> {
  const source = entrypoints.map((entrypoint) =>
    `import ${JSON.stringify(entrypoint.href)};`
  ).join("\n");
  const rootModule = `data:application/typescript,${
    encodeURIComponent(source)
  }`;
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--quiet", "--json", rootModule],
    cwd: repositoryRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(
    result.success,
    true,
    new TextDecoder().decode(result.stderr),
  );

  const graph = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    modules: DenoInfoModule[];
  };
  assert.deepEqual(
    graph.modules.flatMap((module) => module.error ?? []),
    [],
    "Package graph contains invalid modules",
  );
  return graph.modules;
}

function collectImports(
  modules: readonly DenoInfoModule[],
  packageRoot: URL,
  moduleFilter: (local: string) => boolean = () => true,
): string[] {
  const importedPackages = new Set<string>();
  const packagePath = fileURLToPath(packageRoot);
  for (const module of modules) {
    if (
      module.local == null || !module.local.startsWith(packagePath) ||
      !moduleFilter(module.local)
    ) {
      continue;
    }
    for (const dependency of module.dependencies ?? []) {
      const packageName = getPackageName(dependency.specifier);
      if (packageName != null) importedPackages.add(packageName);
    }
  }
  return [...importedPackages].toSorted();
}

async function getProductionImports(directory: string): Promise<string[]> {
  const packageRoot = new URL(`${directory}/`, repositoryRoot);
  const denoConfig = await readJson<{
    exports: string | Record<string, string>;
  }>(new URL("deno.json", packageRoot));
  const exportedEntrypoints = typeof denoConfig.exports === "string"
    ? [denoConfig.exports]
    : [...new Set(Object.values(denoConfig.exports))];
  const entrypoints = [
    ...exportedEntrypoints,
    ...(additionalProductionEntrypoints[directory] ?? []),
  ].map((entrypoint) => new URL(entrypoint, packageRoot));
  return collectImports(await getModuleGraph(entrypoints), packageRoot);
}

async function getTestImports(directory: string): Promise<string[]> {
  const packageRoot = new URL(`${directory}/`, repositoryRoot);
  const entrypoints: URL[] = [];
  async function visit(url: URL): Promise<void> {
    for await (const entry of Deno.readDir(url)) {
      if (entry.name === "node_modules") continue;
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), url);
      if (entry.isDirectory) {
        await visit(child);
      } else if (entry.isFile && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        entrypoints.push(child);
      }
    }
  }
  await visit(packageRoot);
  if (entrypoints.length < 1) return [];
  const modules = await getModuleGraph(entrypoints);
  return collectImports(
    modules,
    packageRoot,
    (local) => /\.test\.[cm]?[jt]sx?$/.test(local),
  );
}

test("core package manifests match production imports", async () => {
  for (const directory of corePackageDirectories) {
    const manifest = await readJson<PackageManifest>(
      new URL(`${directory}/package.json`, repositoryRoot),
    );
    const importedPackages = (await getProductionImports(directory)).filter(
      (packageName) => packageName !== manifest.name,
    );
    const declaredDependencies = Object.keys(manifest.dependencies ?? {})
      .toSorted();
    assert.deepEqual(
      declaredDependencies,
      importedPackages,
      `${manifest.name} production dependencies do not match its imports: ` +
        `declared=${JSON.stringify(declaredDependencies)}, ` +
        `imported=${JSON.stringify(importedPackages)}`,
    );
  }
});

test("core package manifests declare direct test imports", async () => {
  for (const directory of corePackageDirectories) {
    const manifest = await readJson<PackageManifest>(
      new URL(`${directory}/package.json`, repositoryRoot),
    );
    const declaredDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const undeclaredImports = (await getTestImports(directory)).filter(
      (packageName) =>
        packageName !== manifest.name && !declaredDependencies.has(packageName),
    );
    assert.deepEqual(
      undeclaredImports,
      [],
      `${manifest.name} has undeclared direct test imports`,
    );
  }
});

test("workspace package manifests declare all direct source imports", async () => {
  for (const directory of await getWorkspaceDirectories()) {
    const packageRoot = new URL(`${directory}/`, repositoryRoot);
    const manifest = await readJson<PackageManifest>(
      new URL("package.json", packageRoot),
    );
    const declaredDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const undeclaredImports = (await getDirectImports(
      await listSourceFiles(packageRoot),
    )).filter((packageName) =>
      packageName !== manifest.name && !declaredDependencies.has(packageName)
    );
    assert.deepEqual(
      undeclaredImports,
      [],
      `${manifest.name} has undeclared direct source imports: ` +
        JSON.stringify(undeclaredImports),
    );
  }
});

test("root package manifest declares operational and test imports", async () => {
  const manifest = await readJson<PackageManifest>(
    new URL("package.json", repositoryRoot),
  );
  const declaredDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const rootFiles = [
    new URL("drizzle.config.ts", repositoryRoot),
    ...await listSourceFiles(new URL("scripts/", repositoryRoot)),
    ...await listSourceFiles(new URL("test/", repositoryRoot)),
  ];
  const undeclaredImports = (await getDirectImports(rootFiles)).filter(
    (packageName) => !declaredDependencies.has(packageName),
  );
  assert.deepEqual(
    undeclaredImports,
    [],
    "The root package has undeclared direct imports: " +
      JSON.stringify(undeclaredImports),
  );
});

test("Deno and Node package exports match", async () => {
  for (const directory of corePackageDirectories) {
    const packageRoot = new URL(`${directory}/`, repositoryRoot);
    const denoConfig = await readJson<{ exports?: PackageManifest["exports"] }>(
      new URL("deno.json", packageRoot),
    );
    const manifest = await readJson<PackageManifest>(
      new URL("package.json", packageRoot),
    );
    assert.deepEqual(
      manifest.exports,
      denoConfig.exports,
      `${manifest.name} exports differ between package.json and deno.json`,
    );
  }
});

test("workspace package dependency graph is acyclic", async () => {
  const workspaceDirectories = await getWorkspaceDirectories();
  const manifests = await Promise.all(
    workspaceDirectories.map((directory) =>
      readJson<PackageManifest>(
        new URL(`${directory}/package.json`, repositoryRoot),
      )
    ),
  );
  const packageNames = new Set(manifests.map((manifest) => manifest.name));
  const graph = new Map<string, string[]>();
  for (const manifest of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    graph.set(
      manifest.name,
      Object.keys(dependencies).filter((dependency) =>
        packageNames.has(dependency)
      ),
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(packageName: string): void {
    if (visiting.has(packageName)) {
      const cycleStart = path.indexOf(packageName);
      assert.fail(
        `Workspace dependency cycle: ${
          [...path.slice(cycleStart), packageName].join(" -> ")
        }`,
      );
    }
    if (visited.has(packageName)) return;
    visiting.add(packageName);
    path.push(packageName);
    for (const dependency of graph.get(packageName) ?? []) visit(dependency);
    path.pop();
    visiting.delete(packageName);
    visited.add(packageName);
  }

  for (const packageName of graph.keys()) visit(packageName);
});

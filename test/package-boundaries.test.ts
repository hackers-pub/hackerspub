import assert from "node:assert";
import test from "node:test";

interface PackageManifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface DenoInfoModule {
  readonly local?: string;
  readonly dependencies?: readonly { readonly specifier: string }[];
}

const repositoryRoot = new URL("../", import.meta.url);
const workspaceDirectories = [
  "ai",
  "asset-cdn",
  "federation",
  "models",
  "web-next",
] as const;
const corePackageDirectories = ["ai", "federation", "models"] as const;

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

function getPackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") || specifier.startsWith("/") ||
    specifier.startsWith("data:") || specifier.startsWith("file:") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function getProductionImports(directory: string): Promise<string[]> {
  const packageRoot = new URL(`${directory}/`, repositoryRoot);
  const denoConfig = await readJson<{
    exports: Record<string, string>;
  }>(new URL("deno.json", packageRoot));
  const entrypoints = [...new Set(Object.values(denoConfig.exports))];
  const source = entrypoints.map((entrypoint) =>
    `import ${JSON.stringify(new URL(entrypoint, packageRoot).href)};`
  ).join("\n");
  const rootModule = `data:application/typescript,${
    encodeURIComponent(source)
  }`;
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", rootModule],
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
  const importedPackages = new Set<string>();
  const packagePath = decodeURIComponent(packageRoot.pathname);
  for (const module of graph.modules) {
    if (module.local == null || !module.local.startsWith(packagePath)) continue;
    for (const dependency of module.dependencies ?? []) {
      const packageName = getPackageName(dependency.specifier);
      if (packageName != null) importedPackages.add(packageName);
    }
  }
  return [...importedPackages].toSorted();
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

test("workspace package dependency graph is acyclic", async () => {
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

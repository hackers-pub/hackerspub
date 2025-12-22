import { execFile } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execAsync } from "./utils.js";
function isResolveError(info) {
  return "error" in info && typeof info.error === "string";
}
let checkedDenoInstall = false;
const DENO_BINARY = process.platform === "win32" ? "deno.exe" : "deno";
export async function resolveDeno(id, cwd) {
  if (!checkedDenoInstall) {
    try {
      await execAsync(`${DENO_BINARY} --version`, { cwd });
      checkedDenoInstall = true;
    } catch {
      throw new Error(
        `Deno binary could not be found. Install Deno to resolve this error.`,
      );
    }
  }
  // There is no JS-API in Deno to get the final file path in Deno's
  // cache directory. The `deno info` command reveals that information
  // though, so we can use that.
  const output = await new Promise((resolve, reject) => {
    execFile(DENO_BINARY, ["info", "--json", id], { cwd }, (error, stdout) => {
      if (error) {
        if (String(error).includes("Integrity check failed")) {
          reject(error);
        } else {
          resolve(null);
        }
      } else {
        resolve(stdout);
      }
    });
  });
  if (output === null) {
    return null;
  }
  const json = JSON.parse(output);
  const actualId = json.roots[0];
  // Find the final resolved cache path. First, we need to check
  // if the redirected specifier, which represents the final specifier.
  // This is often used for `http://` imports where a server can do
  // redirects.
  const redirected = json.redirects[actualId] ?? actualId;
  // Find the module information based on the redirected speciffier
  const mod = json.modules.find((info) => info.specifier === redirected);
  if (mod === undefined) {
    return null;
  }
  // Specifier not found by deno
  if (isResolveError(mod)) {
    return null;
  }
  if (mod.kind === "esm") {
    return {
      id: mod.local,
      kind: mod.kind,
      loader: mod.mediaType,
      dependencies: mod.dependencies,
    };
  } else if (mod.kind === "npm") {
    return {
      id: mod.npmPackage,
      kind: mod.kind,
      loader: null,
      dependencies: [],
    };
  } else if (mod.kind === "external") {
    // Let vite handle this
    return null;
  } else if (mod.kind === "asserted") {
    return {
      id: mod.local,
      kind: "esm",
      loader: mod.mediaType,
      dependencies: [],
    };
  }
  throw new Error(`Unsupported: ${JSON.stringify(mod, null, 2)}`);
}
export async function resolveViteSpecifier(id, cache, posixRoot, importer) {
  const root = path.normalize(posixRoot);
  // Resolve import map
  if (!id.startsWith(".") && !id.startsWith("/")) {
    try {
      id = import.meta.resolve(id);
    } catch {
      // Ignore: not resolvable
    }
  }
  if (importer && isDenoSpecifier(importer)) {
    const { resolved: parent } = parseDenoSpecifier(importer);
    const cached = cache.get(parent);
    if (cached === undefined) {
      return;
    }
    const found = cached.dependencies.find((dep) => dep.specifier === id);
    if (found === undefined) {
      return;
    }
    // Check if we need to continue resolution
    id = found.code.specifier;
    if (id.startsWith("file://")) {
      return fileURLToPath(id);
    }
  }
  const resolved = cache.get(id) ?? await resolveDeno(id, root);
  // Deno cannot resolve this
  if (resolved === null) {
    return;
  }
  if (resolved.kind === "npm") {
    return null;
  }
  cache.set(resolved.id, resolved);
  // Vite can load this
  if (
    resolved.loader === null ||
    resolved.id.startsWith(path.resolve(root)) &&
      !path.relative(root, resolved.id).startsWith(".")
  ) {
    return resolved.id;
  }
  // We must load it
  return toDenoSpecifier(resolved.loader, id, resolved.id);
}
export function isDenoSpecifier(str) {
  return str.startsWith("\0deno");
}
export function toDenoSpecifier(loader, id, resolved) {
  return `\0deno::${loader}::${id}::${resolved}`;
}
export function parseDenoSpecifier(spec) {
  const [_, loader, id, posixPath] = spec.split("::");
  const resolved = path.normalize(posixPath);
  return { loader: loader, id, resolved };
}

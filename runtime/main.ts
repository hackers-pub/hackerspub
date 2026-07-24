import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function isMain(importMeta: ImportMeta): boolean {
  const denoMain = (importMeta as ImportMeta & { readonly main?: boolean })
    .main;
  if (denoMain != null) return denoMain;
  const entrypoint = process.argv[1];
  return (
    entrypoint != null &&
    pathToFileURL(resolve(entrypoint)).href === importMeta.url
  );
}

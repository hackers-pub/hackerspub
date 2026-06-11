import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { negotiateLocale } from "./i18n.ts";

/**
 * The locales the code of conduct is available in, i.e. the
 * `CODE_OF_CONDUCT.{locale}.md` files at the repository root.
 */
export const COC_LOCALES = ["en", "ja", "ko", "zh-CN", "zh-TW"] as const;

export type CocLocale = (typeof COC_LOCALES)[number];

/**
 * A single provision of the code of conduct, i.e. an H3 subsection of the
 * document.  Provision ids are derived from the document structure
 * (`{section number}.{subsection number}`, both 1-based), which is identical
 * across all locales, so the same id refers to the same provision in every
 * language.  Note that ids are only stable for a given version of the code
 * of conduct; when the document is restructured, ids shift, which is why
 * reports record the code of conduct version they were filed under.
 */
export interface CocProvision {
  /** Structural id of the provision, e.g. `"2.3"`. */
  id: string;
  /** Title of the section (H2 heading) the provision belongs to. */
  section: string;
  /** Title of the provision (H3 heading). */
  title: string;
  /** Markdown body of the provision. */
  text: string;
}

const documentCache = new Map<CocLocale, Promise<string>>();
const provisionsCache = new Map<CocLocale, Promise<CocProvision[]>>();
let versionCache: Promise<string | null> | undefined;

/**
 * Resolves an arbitrary locale to the nearest locale the code of conduct is
 * available in, falling back to English.
 */
export function resolveCocLocale(locale?: string): CocLocale {
  if (locale == null) return "en";
  let wanted: Intl.Locale;
  try {
    wanted = new Intl.Locale(locale);
  } catch {
    return "en";
  }
  const negotiated = negotiateLocale(wanted, COC_LOCALES);
  return negotiated == null ? "en" : negotiated.baseName as CocLocale;
}

/**
 * Reads the full Markdown text of the code of conduct in the given locale
 * (or the nearest available one; English by default).
 */
export function getCodeOfConduct(locale?: string): Promise<string> {
  const cocLocale = resolveCocLocale(locale);
  let document = documentCache.get(cocLocale);
  if (document == null) {
    document = readFile(
      new URL(`../CODE_OF_CONDUCT.${cocLocale}.md`, import.meta.url),
      "utf8",
    );
    documentCache.set(cocLocale, document);
  }
  return document;
}

/**
 * Parses the code of conduct in the given locale (or the nearest available
 * one; English by default) into its provisions.
 */
export function getCocProvisions(locale?: string): Promise<CocProvision[]> {
  const cocLocale = resolveCocLocale(locale);
  let provisions = provisionsCache.get(cocLocale);
  if (provisions == null) {
    provisions = getCodeOfConduct(cocLocale).then(parseCocProvisions);
    provisionsCache.set(cocLocale, provisions);
  }
  return provisions;
}

function parseCocProvisions(markdown: string): CocProvision[] {
  const lines = markdown.split(/\r?\n/);
  const provisions: CocProvision[] = [];
  let sectionIndex = 0;
  let sectionTitle = "";
  let provisionIndex = 0;
  let provisionTitle: string | undefined;
  let provisionLines: string[] = [];

  function flush(): void {
    if (provisionTitle == null) return;
    provisions.push({
      id: `${sectionIndex}.${provisionIndex}`,
      section: sectionTitle,
      title: provisionTitle,
      text: provisionLines.join("\n").trim(),
    });
    provisionTitle = undefined;
    provisionLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const underline = lines[i + 1];
    if (
      underline != null && line.trim() !== "" &&
      /^-{2,}\s*$/.test(underline)
    ) {
      // Setext H2: a section heading.
      flush();
      sectionIndex++;
      sectionTitle = line.trim();
      provisionIndex = 0;
      i++; // Skip the underline.
      continue;
    }
    if (
      underline != null && line.trim() !== "" &&
      /^={2,}\s*$/.test(underline)
    ) {
      // Setext H1: the document title; not a section.
      flush();
      i++;
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3 != null) {
      flush();
      if (sectionIndex > 0) {
        provisionIndex++;
        provisionTitle = h3[1];
      }
      continue;
    }
    if (provisionTitle != null) provisionLines.push(line);
  }
  flush();
  return provisions;
}

/**
 * Returns the version identifier of the code of conduct: the hash of the
 * most recent Git commit that touched any of the `CODE_OF_CONDUCT.*.md`
 * files.  In environments without a Git checkout (e.g. production
 * containers), falls back to the `GIT_COMMIT` environment variable, which
 * the Docker build records; the build commit is a correct upper bound for
 * the code of conduct version.  Returns `null` when neither is available.
 *
 * The result is cached for the lifetime of the process.
 */
export function getCocVersion(): Promise<string | null> {
  versionCache ??= computeCocVersion();
  return versionCache;
}

async function computeCocVersion(): Promise<string | null> {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  try {
    const { stdout } = await promisify(execFile)("git", [
      "log",
      "-1",
      "--format=%H",
      "--",
      "CODE_OF_CONDUCT.md",
      "CODE_OF_CONDUCT.*.md",
    ], { cwd: repoRoot });
    const hash = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(hash)) return hash;
  } catch {
    // Git unavailable or not a repository; fall through.
  }
  const buildCommit = process.env.GIT_COMMIT?.trim();
  return buildCommit != null && buildCommit !== "" ? buildCommit : null;
}

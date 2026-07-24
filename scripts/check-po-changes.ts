import { po } from "gettext-parser";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

interface PoEntry {
  msgid: string;
  msgid_plural?: string;
  msgstr: string[];
}

interface Translation {
  msgid: string;
  msgid_plural?: string;
  msgstr: string[];
}

function extractTranslations(content: string): Map<string, Translation> {
  const parsed = po.parse(content) as {
    translations: Record<string, Record<string, PoEntry>>;
  };
  const result = new Map<string, Translation>();

  for (const [context, entries] of Object.entries(parsed.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (msgid === "" && context === "") continue; // skip the header entry

      // Follow standard gettext convention: context\x04msgid as the composite key
      const key = context ? `${context}\x04${msgid}` : msgid;

      result.set(key, {
        msgid: entry.msgid,
        msgid_plural: entry.msgid_plural,
        msgstr: entry.msgstr,
      });
    }
  }

  return result;
}

async function checkPoFile(file: string): Promise<boolean> {
  const gitResult = spawnSync("git", ["show", `HEAD:${file}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (gitResult.status !== 0) {
    // File is not yet tracked in git; skip — other CI steps handle new files.
    return true;
  }

  const committedContent = gitResult.stdout;
  const currentContent = await readFile(file, "utf8");

  const committed = extractTranslations(committedContent);
  const current = extractTranslations(currentContent);

  let hasChanges = false;

  for (const [key, translation] of current) {
    const prev = committed.get(key);
    if (prev === undefined) {
      console.error(
        `::error file=${file}::New translation entry not committed: ${JSON.stringify(
          translation.msgid,
        )}`,
      );
      hasChanges = true;
    } else if (
      translation.msgid_plural !== prev.msgid_plural ||
      JSON.stringify(translation.msgstr) !== JSON.stringify(prev.msgstr)
    ) {
      console.error(
        `::error file=${file}::Translation changed but not committed: ${JSON.stringify(
          translation.msgid,
        )}`,
      );
      hasChanges = true;
    }
  }

  for (const [key, translation] of committed) {
    if (!current.has(key)) {
      console.error(
        `::error file=${file}::Translation entry removed but not committed: ${JSON.stringify(
          translation.msgid,
        )}`,
      );
      hasChanges = true;
    }
  }

  return !hasChanges;
}

const files = process.argv.slice(2);
if (files.length > 0) {
  let allPassed = true;
  for (const file of files) {
    if (!(await checkPoFile(file))) allPassed = false;
  }
  if (!allPassed) process.exitCode = 1;
}

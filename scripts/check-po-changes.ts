import { po } from "gettext-parser";

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
  const gitCmd = new Deno.Command("git", {
    args: ["show", `HEAD:${file}`],
    stdout: "piped",
    stderr: "null",
  });
  const gitResult = await gitCmd.output();
  if (!gitResult.success) {
    // File is not yet tracked in git; skip — other CI steps handle new files.
    return true;
  }

  const committedContent = new TextDecoder().decode(gitResult.stdout);
  const currentContent = await Deno.readTextFile(file);

  const committed = extractTranslations(committedContent);
  const current = extractTranslations(currentContent);

  let hasChanges = false;

  for (const [key, translation] of current) {
    const prev = committed.get(key);
    if (prev === undefined) {
      console.error(
        `::error file=${file}::New translation entry not committed: ${
          JSON.stringify(translation.msgid)
        }`,
      );
      hasChanges = true;
    } else if (
      translation.msgid_plural !== prev.msgid_plural ||
      JSON.stringify(translation.msgstr) !== JSON.stringify(prev.msgstr)
    ) {
      console.error(
        `::error file=${file}::Translation changed but not committed: ${
          JSON.stringify(translation.msgid)
        }`,
      );
      hasChanges = true;
    }
  }

  for (const [key, translation] of committed) {
    if (!current.has(key)) {
      console.error(
        `::error file=${file}::Translation entry removed but not committed: ${
          JSON.stringify(translation.msgid)
        }`,
      );
      hasChanges = true;
    }
  }

  return !hasChanges;
}

if (Deno.args.length === 0) Deno.exit(0);

let allPassed = true;
for (const file of Deno.args) {
  if (!await checkPoFile(file)) allPassed = false;
}
if (!allPassed) Deno.exit(1);

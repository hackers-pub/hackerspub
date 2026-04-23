---
name: i18n
description: >
  Fill in missing translations in web-next .po files, add i18n-aware UI
  labels to components, and ensure translation quality — consistent glossary
  terminology, correct punctuation/typography per language, proper formality
  levels, and placeholder preservation.  Use when translating UI labels,
  reviewing translations, managing glossaries, or adding new translatable
  strings to components.
allowed-tools: Read, Edit, Write, Grep, Glob, Agent, AskUserQuestion
---

Translation & i18n skill
========================

Fill in missing translations (`msgstr ""`) in all
`web-next/src/locales/*/messages.po` files and ensure every translation
meets the quality standards below.


Adding translatable strings to components
-----------------------------------------

Import from `~/lib/i18n/macro.d.ts`.  Always call `useLingui()` at the
top of the component to get the translation helpers.

### Simple text

~~~~ tsx
import { useLingui } from "~/lib/i18n/macro.d.ts";

function MyComponent() {
  const { t } = useLingui();
  return <Button>{t`Save`}</Button>;
}
~~~~

`t` works in JSX children, attributes, and any expression context:

~~~~ tsx
<Button title={t`Reply`}>…</Button>
<TextFieldLabel>{t`Content`}</TextFieldLabel>
placeholder={t`Search a language…`}
aria-label={t`Language`}
~~~~

### Variable interpolation

Embed runtime values directly in the template literal:

~~~~ tsx
const { t } = useLingui();
t`Failed to sign out: ${error.message}`
t`To follow ${displayName()}, enter your Fediverse handle.`
~~~~

### Translations with JSX elements (Trans component)

When a translation needs inline JSX (links, bold, components), use the
`<Trans>` component from `~/components/Trans.tsx`.  Placeholder keys use
`SCREAMING_SNAKE_CASE`:

~~~~ tsx
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

function MyComponent() {
  const { t } = useLingui();
  return (
    <Trans
      message={t`Verified that this link is owned by ${"OWNER"} ${"RELATIVE_TIME"}`}
      values={{
        OWNER: () => <strong>{actor().name}</strong>,
        RELATIVE_TIME: () => <Timestamp value={verified()} />,
      }}
    />
  );
}
~~~~

### Pluralization

Use `i18n._(msg`…`)` combined with `plural()`.  The `#` symbol is
replaced with the count:

~~~~ tsx
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";

function FollowerCount(props: { count: number }) {
  const { i18n } = useLingui();
  return (
    <span>
      {i18n._(
        msg`${
          plural(props.count, {
            one: "# follower",
            other: "# followers",
          })
        }`,
      )}
    </span>
  );
}
~~~~

### Accessing the current locale

Use `i18n.locale` for locale-aware formatting (e.g., `Intl` APIs):

~~~~ tsx
const { i18n } = useLingui();
date.toLocaleString(i18n.locale, { dateStyle: "full" })
~~~~


Extracting messages
-------------------

Before translating, run the extraction command to ensure `.po` files are
up to date with the latest source code:

~~~~ sh
cd web-next && deno task extract
~~~~

This runs `@lingui/cli extract`, which scans `web-next/src/` for
translatable strings (`` t`...` ``, `` msg`...` ``, `plural(...)`) and
updates all `web-next/src/locales/*/messages.po` files.  New strings
appear as entries with empty `msgstr ""`.

Run this **before** starting translation work to pick up any newly added
or changed strings.


Workflow
--------

1.  Run `cd web-next && deno task extract` to update `.po` files.
2.  For each locale, read **both** of these before translating:
     -  `web-next/src/locales/{locale}/glossary.txt` — mandatory terminology
     -  `web/locales/{corresponding-legacy-locale}.json` — reference
        translations from the legacy stack
        (locale mapping: `en-US` → `en`, `ja-JP` → `ja`, `ko-KR` → `ko`,
        `zh-CN` → `zh-CN`, `zh-TW` → `zh-TW`)
3.  Fill every empty `msgstr ""` with a translation that follows all rules
    below.
4.  After translating, review existing non-empty `msgstr` entries for rule
    violations and fix them too.


Glossary enforcement
--------------------

 -  **Always** use the exact term from `glossary.txt` when the source text
    contains a glossary term.
 -  If you encounter a term that should be standardized but is **not** in the
    glossary, ask the user via `AskUserQuestion` whether to add it.
 -  If the user agrees, add the entry to **every** locale's `glossary.txt`
    in the format `term → translation` (one per line, sorted alphabetically).


Punctuation & typography
------------------------

### All languages

| Rule     | Correct       | Wrong      |
| -------- | ------------- | ---------- |
| Ellipsis | `…` (U+2026)  | `...`      |
| Em dash  | `—` (U+2014)  | `--`       |
| Casing   | Sentence case | Title Case |

### en-US

 -  Quotation marks: `"` `"` (curly double), `'` `'` (curly single)
 -  Standard English punctuation rules

### ja-JP

 -  Quotation marks: `「」`(single), `『』`(double/nested)
 -  Fullwidth punctuation: `。` `、` `！` `？`
 -  No space before/after punctuation

### ko-KR

 -  Quotation marks: `「」`(single), `『』`(double/nested)
 -  Period: halfwidth `.` (not fullwidth `。` — this is Korean standard)
 -  Comma, exclamation, question: `,` `!` `?` (halfwidth, Korean standard)
 -  No space before punctuation

### zh-CN

 -  Quotation marks: `「」`(single), `『』`(double/nested)
 -  Fullwidth punctuation: `。` `、` `！` `？`
 -  No space before/after punctuation

### zh-TW

 -  Quotation marks: `「」`(single), `『』`(double/nested)
 -  Fullwidth punctuation: `。` `、` `！` `？`
 -  No space before/after punctuation


Formality & tone
----------------

| Locale | Style                                                 |
| ------ | ----------------------------------------------------- |
| ko-KR  | 합쇼체(~합니다) 기본. 리듬감을 위해 가끔 해요체 허용. |
| ja-JP  | です/ます form for UI text                            |
| en-US  | Neutral, professional                                 |
| zh-CN  | 简体中文标准用语                                      |
| zh-TW  | 繁體中文標準用語                                      |


CJK-Latin spacing
-----------------

When Latin characters (English words, brand names, numbers) appear next to
CJK characters, follow these language-specific rules:

| Locale | Rule                                                   | Example                              |
| ------ | ------------------------------------------------------ | ------------------------------------ |
| ja-JP  | **No space** — particles attach directly               | `GitHubリポジトリ`, `Markdownを使用` |
| ko-KR  | **Space** before Latin text; particles attach to Latin | `GitHub 저장소`, `Markdown을 사용`   |
| zh-CN  | **Space** on both sides of Latin text                  | `启用了 ActivityPub 的社交网络`      |
| zh-TW  | **Space** on both sides of Latin text                  | `啟用了 ActivityPub 的社交網路`      |


Brand names & proper nouns
--------------------------

Never translate brand names or protocol names. Keep them as-is:

 -  **Hackers' Pub**, **GitHub**, **Mastodon**, **Misskey**, **Pixelfed**
 -  **ActivityPub**, **Markdown**, **WebFinger**

For “fediverse”, follow glossary — some languages use a localized term
(ja-JP: フェディバース, ko-KR: 연합우주) while others keep the original.


Terminal punctuation by UI element
----------------------------------

| UI element              | Punctuation                                                   |
| ----------------------- | ------------------------------------------------------------- |
| Button / action label   | No trailing punctuation in any language                       |
| Menu item               | No trailing punctuation                                       |
| Description / help text | End with period (en: `.`, ja: `。`, ko: `.`, zh: `。`)        |
| Question / confirmation | End with question mark (en: `?`, ja: `？`, ko: `?`, zh: `？`) |
| Title / heading         | No trailing punctuation                                       |


Escape sequences
----------------

 -  Preserve `\n` line breaks from `msgid` exactly in `msgstr`.
 -  Use `\n\n` for paragraph breaks (e.g., in email content).
 -  Never convert `\n` to literal newlines or vice versa.


Gender-neutral language
-----------------------

 -  **en-US**: Use “they/their” for third-person singular when gender is
    unknown. Prefer second person “you/your” where natural.
 -  **ja-JP**: Use honorific “さん” for person references.
 -  **ko-KR / zh-CN / zh-TW**: These languages are largely gender-neutral
    by default; avoid unnecessarily gendered terms.


Placeholder & syntax rules
--------------------------

 -  Preserve **all** placeholders (`{0}`, `{1}`, `#`, etc.) exactly as they
    appear in `msgid`.
 -  Preserve ICU MessageFormat syntax (`plural`, `select`, `selectordinal`)
    exactly—only translate the human-readable parts inside.
 -  Never translate placeholder variable names or format specifiers.


Quality checklist
-----------------

Before finishing, verify each translation:

 -  [ ] Glossary terms match `glossary.txt` exactly
 -  [ ] Punctuation follows the locale-specific rules above
 -  [ ] CJK-Latin spacing follows the locale-specific rules
 -  [ ] Brand names are kept as-is, not translated
 -  [ ] Terminal punctuation matches UI element type
 -  [ ] All placeholders from `msgid` are present in `msgstr`
 -  [ ] ICU MessageFormat syntax is valid
 -  [ ] Escape sequences (`\n`) are preserved
 -  [ ] Formality level matches the locale convention
 -  [ ] Gender-neutral language is used
 -  [ ] Translation is concise and natural for UI context

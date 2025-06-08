# Guide for LLM-Powered Agents

This file provides guidance to LLM-powered agents when working with code in this repository.

## Stack Migration Status

This project is currently in a transitional phase, migrating from an existing Fresh + Preact stack to a new SolidStart + Solid + GraphQL + Relay stack:

- **Legacy Stack (web/)**: Fresh framework with Preact, JSX for templating, direct database queries
- **New Stack (web-next/)**: SolidStart with Solid.js, GraphQL with Relay, Lingui for i18n

### Working with Both Stacks

- **Maintain the legacy stack** in `web/` directory for existing functionality
- **Develop new features** in `web-next/` directory using the new stack
- **Do not mix technologies** between the two directories
- The migration will be completed over several weeks

### When to Use Which Stack

- Use `web/` for:
  - Bug fixes and maintenance of existing features
  - Features that need immediate deployment
  - Any work specifically requested for the legacy system

- Use `web-next/` for:
  - New feature development
  - Modern UI components and patterns
  - Any new internationalization work
  - GraphQL schema changes and Relay integration

## Build/Lint/Test Commands

- Build: `deno task build`
- Lint/Format Check: `deno task check`
- Run Dev Server: `deno task dev`
- Run Tests: `deno task test`
- Database Migration: `deno task migrate`
- Pre-commit Hook: `deno task hooks:pre-commit`

## Code Style Guidelines

### General
- Format code with `deno fmt` before submitting PRs
- Use spaces for indentation (not tabs)

### Commit Messages
- First line should be short and concise
- Clearly describe the purpose of the changes

### Imports
- External imports first, internal imports second (alphabetically within groups)
- Use `type` keyword for type imports when appropriate

### Naming
- camelCase for variables, functions, and methods
- PascalCase for classes, interfaces, types, and components
- Files with components use PascalCase (Button.tsx)
- Model files use lowercase (post.ts)
- Tests have a `.test.ts` suffix

### TypeScript
- Use explicit typing for complex return types
- Use interfaces for component props (e.g., ButtonProps)

### Components
- Use functional components with props destructuring
- Tailwind CSS for styling
- Components in components/ directory
- Interactive components in islands/ directory (Fresh framework pattern)

### Error Handling
- Use structured logging via LogTape
- Include context in error details

## Internationalization (i18n)

### Legacy Stack (web/)
- Uses explicit translation string IDs with JSON files
- Translation files: `web/locales/{locale}.json`
- Terminology glossary: Located at the top of each JSON file under "glossary" key
- Usage: Access translations via i18n functions with string IDs

### New Stack (web-next/)
- Uses Lingui with gettext-style approach (source text as key)
- Translation files: `web-next/src/locales/{locale}/messages.po`
- Terminology glossaries: `web-next/src/locales/{locale}/glossary.txt`
- Supported locales: en-US, ja-JP, ko-KR, zh-CN, zh-TW
- Language selection: URL query parameter `?lang={locale}` or Accept-Language header

### Translation Usage in New Stack
- Import: `import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts"`
- Simple translation: `const { t } = useLingui(); t\`Hello world\``
- With pluralization: `const { i18n } = useLingui(); i18n._(msg\`${plural(count, { one: "# follower", other: "# followers" })}\`)`

### Translation Guidelines for New Stack
- Always reference the appropriate glossary file when translating
- Use consistent terminology across the application as defined in glossaries
- For technical terms, follow the glossary mappings (e.g., "post" → "コンテンツ" in Japanese)
- Maintain proper pluralization rules in .po files
- Test translations with `?lang={locale}` parameter

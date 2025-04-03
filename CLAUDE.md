# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Include only "Co-Authored-By: Claude <noreply@anthropic.com>" (do not include "Generated with Claude Code")

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

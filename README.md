# Hackers' Pub

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/hackers-pub/hackerspub/main.yml?branch=main&label=ci)](https://github.com/hackers-pub/hackerspub/actions/workflows/main.yml)

Hackers' Pub is an ActivityPub-enabled social network for hackers. Think of it as a federated publishing and discussion platform for technical communities, with long-form posts, rich Markdown, multilingual support, and a timeline designed for developer conversation.

> Hackers' Pub is currently under active development and invite-only.

## Table of contents
- [Why this project exists](#why-this-project-exists)
- [Core features](#core-features)
- [Quick start for local development](#quick-start-for-local-development)
- [Environment setup](#environment-setup)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [License](#license)

## Why this project exists
Hackers' Pub aims to give technical communities a federated alternative to centralized publishing platforms. It combines blogging, social interaction, and ActivityPub federation in a product shaped for engineers and multilingual internet communities.

## Core features
- ActivityPub federation with Mastodon-compatible servers
- rich Markdown, including tables, footnotes, callouts, diagrams, and math
- multilingual posting and automatic translation support
- algorithmic or chronological timeline views
- open source codebase with self-hosting paths for experimentation

## Quick start for local development
The repository ships with a development container and sample environment file.

```bash
cp .env.sample .env
pnpm install

deno task -r codegen
deno task dev
```

If you prefer container-based setup, `Dockerfile.dev` provides a ready-made development image with `mise`, `pnpm`, `deno`, and media dependencies preinstalled.

## Environment setup
Common variables in `.env.sample` include:
- `ORIGIN` and `API_URL` for the main web and GraphQL endpoints
- `DATABASE_URL` and `KV_URL` for persistence
- `SECRET_KEY` and `INSTANCE_ACTOR_KEY` for instance identity and signing
- mail, storage, analytics, and AI provider settings for optional integrations

## Repository layout
- `web-next/` , Next.js frontend
- `graphql/` , GraphQL API
- `federation/` , ActivityPub and federation logic
- `models/` , shared data models
- `.devcontainer/` and `Dockerfile.dev` , reproducible development environments

## Contributing
If you want to contribute, start with [CONTRIBUTING.md](CONTRIBUTING.md), then review the project design docs and local agent instructions if you are using AI-assisted tooling.

## License
Hackers' Pub is released under the [AGPL-3.0 License](LICENSE).

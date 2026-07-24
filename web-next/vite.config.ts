import { resolve } from "node:path";
import process from "node:process";
import { lingui } from "@lingui/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { solidStart } from "@solidjs/start/config";
import { nitroV2Plugin } from "@solidjs/vite-plugin-nitro-2";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import Icons from "unplugin-icons/vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { defineConfig } from "vite";
import relay from "vite-plugin-relay-lite";
import packageJson from "./package.json" with { type: "json" };

try {
  process.loadEnvFile(resolve(process.cwd(), "../.env"));
} catch {
  console.warn("No .env file found.");
}

// Sentry source-map upload runs only when an auth token is provided at
// build time — typically inside CI, fed in via a Docker BuildKit secret
// (see Dockerfile). For local builds and any image build without the
// secret, the plugin is omitted entirely so nothing tries to talk to
// Sentry. SENTRY_ORG / SENTRY_PROJECT default to the values used by
// this repo's Sentry project; override via env if you fork.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryPlugins = sentryAuthToken
  ? [
      sentryVitePlugin({
        org: process.env.SENTRY_ORG ?? "hackerspub",
        project: process.env.SENTRY_PROJECT ?? "web-next",
        authToken: sentryAuthToken,
        // Tag the uploaded source maps with the same release identifier the
        // SDK reports at runtime (entry-client.tsx and instrument.server.mjs
        // both pass packageJson.version). The Dockerfile bumps version to
        // `0.2.0+<git_commit>` *before* the web-next build, so Sentry sees
        // a unique release per deployed commit.
        release: { name: packageJson.version },
      }),
    ]
  : [];

export default defineConfig(() => ({
  // Emit production source maps into the deployed web-next output. Client
  // bundles keep their `sourceMappingURL` comments so browser DevTools can
  // load the maps, and server bundles keep theirs so Node can map production
  // stack traces when started with `--enable-source-maps`.
  build: { sourcemap: true },
  plugins: [
    solidStart({
      middleware: "src/middleware.ts",
      solid: {
        babel: {
          plugins: ["@lingui/babel-plugin-lingui-macro"],
        },
      },
    }),
    nitroV2Plugin({
      esbuild: {
        options: {
          target: "esnext",
        },
      },
    }),
    devtools({
      autoname: true,
      locator: {
        targetIDE: "vscode",
        jsxLocation: true,
        componentLocation: true,
      },
    }),
    tailwindcss(),
    lingui(),
    relay({ codegen: process.env.NO_WATCHMAN == "1" ? false : true }),
    cjsInterop({ dependencies: ["relay-runtime"] }),
    Icons({ compiler: "solid" }),
    // Has to come after the bundling plugins so it sees the final
    // emitted assets (and their .map files).
    ...sentryPlugins,
  ],
}));

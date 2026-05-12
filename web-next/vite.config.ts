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
} catch (e) {
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
      sourcemaps: {
        // Strip .map files from the production output after they have
        // been uploaded to Sentry, so they don't ship in the public
        // Docker image and aren't reachable from the open web. Sentry
        // can still symbolicate stack traces because it has its own
        // copy of the maps.
        filesToDeleteAfterUpload: [
          "./.output/public/_build/assets/*.map",
          "./.output/server/**/*.map",
        ],
      },
    }),
  ]
  : [];

export default defineConfig(() => ({
  // 'hidden' emits .map files for the Sentry plugin to upload but omits
  // the trailing `//# sourceMappingURL=` comment from the .js bundles.
  // Without that comment the browser doesn't try to fetch the maps —
  // which matters because the maps get deleted from the build output
  // after upload (see `filesToDeleteAfterUpload` below), so the browser
  // would otherwise log "Source map error" warnings on every page load.
  // Sentry still gets the maps because the plugin reads them from disk
  // during the build, before the deletion step runs.
  build: { sourcemap: "hidden" },
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

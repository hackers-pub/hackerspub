import deno from "@deno/vite-plugin";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import Icons from "unplugin-icons/vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import relay from "vite-plugin-relay-lite";

// JSR packages that Vite cannot resolve need to be externalized.
// This plugin marks them as external so Vite doesn't try to resolve them.
const jsrExternals = ["@logtape/logtape"];

function jsrExternalPlugin() {
  return {
    name: "jsr-external",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (jsrExternals.some((ext) => id === ext || id.startsWith(`${ext}/`))) {
        return { id, external: true };
      }
    },
  };
}

export default defineConfig({
  vite: () => ({
    server: {
      fs: {
        // For serving Pretendard Variable dynamic subsets
        // Deno installs the dependencies at the root of the workspace,
        // so the subset files are located inside the root node_modules.
        allow: ["../node_modules"],
      },
    },
    optimizeDeps: {
      // JSR packages that cannot be pre-bundled by Vite need to be excluded
      exclude: jsrExternals,
    },
    ssr: {
      // JSR packages that cannot be bundled by Vite need to be externalized
      external: jsrExternals,
    },
    build: {
      rollupOptions: {
        external: jsrExternals,
      },
    },
    plugins: [
      jsrExternalPlugin(),
      devtools({
        autoname: true,
        locator: {
          targetIDE: "vscode",
          jsxLocation: true,
          componentLocation: true,
        },
      }),
      deno(),
      tailwindcss(),
      lingui(),
      relay(),
      cjsInterop({ dependencies: ["relay-runtime"] }),
      Icons({ compiler: "solid" }),
    ],
  }),
  server: {
    esbuild: {
      options: {
        target: "esnext",
      },
    },
  },
  solid: {
    babel: {
      plugins: ["@lingui/babel-plugin-lingui-macro"],
    },
  },
});

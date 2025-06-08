import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import relay from "vite-plugin-relay-lite";

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
    plugins: [
      tailwindcss(),
      lingui(),
      relay(),
      cjsInterop({ dependencies: ["relay-runtime"] }),
    ],
  }),
  solid: {
    babel: {
      plugins: ["@lingui/babel-plugin-lingui-macro"],
    },
  },
});

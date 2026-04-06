import process from "node:process";

import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import Icons from "unplugin-icons/vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import relay from "vite-plugin-relay-lite";

export default defineConfig({
  vite: () => ({
    plugins: [
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

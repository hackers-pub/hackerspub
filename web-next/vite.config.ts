import process from "node:process";

import { lingui } from "@lingui/vite-plugin";
import { solidStart } from "@solidjs/start/config";
import { nitroV2Plugin } from "@solidjs/vite-plugin-nitro-2";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import Icons from "unplugin-icons/vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { defineConfig } from "vite";
import relay from "vite-plugin-relay-lite";

export default defineConfig(() => ({
  plugins: [
    solidStart({
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
  ],
}));

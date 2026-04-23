import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "storybook-solidjs-vite";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// Normalize react-docgen-typescript output so Storybook picks the right control:
//   1. Strip `null` entries from enum unions (cva's VariantProps emits `… | null`).
//   2. Collapse `{name:"enum", raw:"string", value:[{value:"string"}]}` back to
//      `{name:"string"}` — `shouldExtractValuesFromUnion` wraps plain primitives
//      as single-value enums, which Storybook then renders as a select.
const normalizeDocgenEnums: Plugin = {
  name: "storybook-normalize-docgen-enums",
  enforce: "post",
  transform(code) {
    if (!code.includes("__docgenInfo")) return;
    let next = code.replace(/\{\s*"?value"?\s*:\s*"null"\s*\},?/g, "");
    next = next.replace(
      /"type"\s*:\s*\{\s*"name"\s*:\s*"enum"\s*,\s*"raw"\s*:\s*"(string|number|boolean)"\s*,\s*"value"\s*:\s*\[\s*\{\s*"value"\s*:\s*"\1"\s*\}\s*\]\s*\}/g,
      '"type":{"name":"$1"}',
    );
    return next === code ? undefined : { code: next, map: null };
  },
};

const config: StorybookConfig = {
  framework: {
    name: "storybook-solidjs-vite",
    options: {
      docgen: {
        savePropValueAsString: true,
        shouldExtractLiteralValuesFromEnum: true,
        shouldExtractValuesFromUnion: true,
        shouldRemoveUndefinedFromOptional: true,
        propFilter: (prop) =>
          prop.parent ? !/node_modules/.test(prop.parent.fileName) : true,
      },
    },
  },
  stories: ["../src/**/*.stories.@(ts|tsx|mdx)"],
  addons: ["@storybook/addon-docs"],
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [
      ...(viteConfig.plugins ?? []),
      tailwindcss(),
      normalizeDocgenEnums,
    ];
    const existingAlias = viteConfig.resolve?.alias;
    viteConfig.resolve = {
      ...viteConfig.resolve,
      alias: Array.isArray(existingAlias)
        ? [...existingAlias, {
          find: "~",
          replacement: resolve(here, "../src"),
        }]
        : {
          ...existingAlias,
          "~": resolve(here, "../src"),
        },
    };
    return viteConfig;
  },
};

export default config;

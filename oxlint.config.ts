import { defineConfig } from "oxlint";

export default defineConfig({
  jsPlugins: [
    "./web-next/lint-plugins/keyed-show.ts",
    "./web-next/lint-plugins/no-load-query-in-router-query.ts",
  ],
  categories: {
    correctness: "error",
  },
  plugins: ["import", "typescript", "unicorn"],
  rules: {
    "hackerspub-solid/show-keyed-on-fn-child": "error",
    "hackerspub-solid-relay/no-load-query-in-router-query": "error",
  },
  overrides: [
    {
      files: ["web-next/**/*.tsx"],
      rules: {
        "eslint/no-unassigned-vars": "off",
      },
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "unicorn/no-thenable": "off",
      },
    },
  ],
  ignorePatterns: [
    ".agents/**",
    ".claude/**",
    "drizzle/**",
    "patches/**",
    "**/__generated__/**",
    "**/.output/**",
    "**/.nitro/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/storybook-static/**",
  ],
});

import { defineConfig } from "oxlint";

export default defineConfig({
  jsPlugins: [
    "@fedify/lint/oxlint",
    { name: "@logtape", specifier: "@logtape/lint/eslint" },
    "eslint-plugin-solid",
    "./lint-plugins/keyed-show.ts",
    "./lint-plugins/no-deno-globals.ts",
    "./lint-plugins/no-load-query-in-router-query.ts",
  ],
  categories: {
    correctness: "error",
  },
  plugins: ["import", "typescript", "unicorn"],
  rules: {
    "@fedify/lint/actor-assertion-method-required": "warn",
    "@fedify/lint/actor-featured-property-mismatch": "warn",
    "@fedify/lint/actor-featured-property-required": "warn",
    "@fedify/lint/actor-featured-tags-property-mismatch": "warn",
    "@fedify/lint/actor-featured-tags-property-required": "warn",
    "@fedify/lint/actor-followers-property-mismatch": "warn",
    "@fedify/lint/actor-followers-property-required": "warn",
    "@fedify/lint/actor-following-property-mismatch": "warn",
    "@fedify/lint/actor-following-property-required": "warn",
    "@fedify/lint/actor-id-mismatch": "error",
    "@fedify/lint/actor-id-required": "error",
    "@fedify/lint/actor-inbox-property-mismatch": "warn",
    "@fedify/lint/actor-inbox-property-required": "warn",
    "@fedify/lint/actor-liked-property-mismatch": "warn",
    "@fedify/lint/actor-liked-property-required": "warn",
    "@fedify/lint/actor-outbox-property-mismatch": "warn",
    "@fedify/lint/actor-outbox-property-required": "warn",
    "@fedify/lint/actor-public-key-required": "warn",
    "@fedify/lint/actor-shared-inbox-property-mismatch": "warn",
    "@fedify/lint/actor-shared-inbox-property-required": "warn",
    "@fedify/lint/collection-filtering-not-implemented": "warn",
    "@fedify/lint/outbox-listener-delivery-required": "warn",
    "@logtape/no-message-interpolation": "error",
    "@logtape/no-unawaited-log": "error",
    "@logtape/prefer-lazy-evaluation": "warn",
    "@logtape/require-meta-sink": "warn",
    "hackerspub-runtime/no-deno-globals": "error",
    "hackerspub-solid/show-keyed-on-fn-child": "error",
    "hackerspub-solid-relay/no-load-query-in-router-query": "error",
  },
  overrides: [
    {
      files: ["web-next/**/*.{ts,tsx}"],
      rules: {
        // Enable these recommended rules after the existing violations have
        // been migrated.  `mise run check` denies warnings, so even the
        // preset's warning-level rules must start from a clean baseline.
        "solid/components-return-once": "off",
        "solid/event-handlers": "warn",
        "solid/imports": "warn",
        "solid/jsx-no-duplicate-props": "error",
        "solid/jsx-no-script-url": "error",
        "solid/jsx-no-undef": ["error", { typescriptEnabled: true }],
        "solid/jsx-uses-vars": "error",
        "solid/no-destructure": "error",
        // Audit the existing rich-text rendering sites separately before
        // enabling this rule across web-next.
        "solid/no-innerhtml": "off",
        "solid/no-react-deps": "warn",
        "solid/no-react-specific-props": "warn",
        "solid/no-unknown-namespaces": "off",
        "solid/prefer-for": "off",
        "solid/reactivity": "off",
        "solid/self-closing-comp": "warn",
        "solid/style-prop": "warn",
      },
    },
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

import type { defineConfig } from "@lingui/cli";

export default {
  sourceLocale: "en-US",
  locales: ["en-US", "ja-JP", "ko-KR", "zh-CN", "zh-TW"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
    },
  ],
  runtimeConfigModule: {
    useLingui: ["~/lib/i18n/index.tsx", "useLinguiImpl"],
  },
  macro: {
    corePackage: ["~/lib/i18n/macro.d.ts"],
    jsxPackage: ["~/lib/i18n/macro.d.ts"],
  },
} satisfies ReturnType<typeof defineConfig>;

import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "../graphql/schema.graphql",
  documents: ["**/*.{ts,tsx}", "!node_modules"],
  ignoreNoDocuments: true,
  emitLegacyCommonJSImports: false,
  generates: {
    "./graphql/__generated__/": {
      preset: "client",
      presetConfig: {
        extension: ".ts",
      },
      config: {
        scalars: {
          Date: "Date",
          DateTime: "Date",
          HTML: "string",
          JSON: "unknown",
          Locale: "Intl.Locale | string",
          Markdown: "string",
          MediaType: "string",
          URL: "URL",
          UUID: "`${string}-${string}-${string}-${string}-${string}`",
        },
        strictScalars: true,
        useTypeImports: true,
        enumsAsConst: true,
        skipTypename: true,
      },
    },
  },
  hooks: {
    beforeOneFileWrite: (_, content: string) =>
      "//@ts-nocheck\n" +
      content.replaceAll(/(from\s+['"].+)\.js(['"])/g, "$1.ts$2"),
  },
};

export default config;

interface RegExpConstructor {
  readonly escape?: (value: string) => string;
}

declare module "cssfilter" {
  export const whiteList: Record<string, readonly string[]>;
}

declare module "@hackerspub/markdown-it-texmath" {
  const plugin: import("markdown-it").PluginWithOptions<
    Record<string, unknown>
  >;
  export default plugin;
}

declare module "@searking/markdown-it-cjk-breaks" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

declare module "markdown-it-abbr" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

declare module "markdown-it-deflist" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

declare module "markdown-it-footnote" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

declare module "markdown-it-github-alerts" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

declare module "markdown-it-graphviz" {
  const plugin: import("markdown-it").PluginSimple;
  export default plugin;
}

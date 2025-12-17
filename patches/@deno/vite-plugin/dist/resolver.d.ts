export type DenoMediaType =
  | "TypeScript"
  | "TSX"
  | "JavaScript"
  | "JSX"
  | "Json";
interface ResolvedInfo {
  kind: "esm";
  local: string;
  size: number;
  mediaType: DenoMediaType;
  specifier: string;
  dependencies: Array<{
    specifier: string;
    code: {
      specifier: string;
      span: {
        start: unknown;
        end: unknown;
      };
    };
  }>;
}
export interface DenoResolveResult {
  id: string;
  kind: "esm" | "npm";
  loader: DenoMediaType | null;
  dependencies: ResolvedInfo["dependencies"];
}
export declare function resolveDeno(
  id: string,
  cwd: string,
): Promise<DenoResolveResult | null>;
export declare function resolveViteSpecifier(
  id: string,
  cache: Map<string, DenoResolveResult>,
  posixRoot: string,
  importer?: string,
): Promise<string>;
export type DenoSpecifierName = string & {
  __brand: "deno";
};
export declare function isDenoSpecifier(str: string): str is DenoSpecifierName;
export declare function toDenoSpecifier(
  loader: DenoMediaType,
  id: string,
  resolved: string,
): DenoSpecifierName;
export declare function parseDenoSpecifier(spec: DenoSpecifierName): {
  loader: DenoMediaType;
  id: string;
  resolved: string;
};
export {};

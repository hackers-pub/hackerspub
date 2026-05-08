// deno-lint-ignore-file no-explicit-any
//
// Custom Deno lint plugin: prevent returning solid-relay PreloadedQuery
// objects from @solidjs/router query() fetchers.
//
// Solid Router query() caches return values for preloads, active subscribers,
// history navigation, and hydration. solid-relay loadQuery() returns a
// PreloadedQuery whose lifetime is tied to createPreloadedQuery(); that
// primitive disposes the query when the component unmounts. Caching that
// disposable object in query() lets a later navigation reuse an already
// disposed PreloadedQuery, which trips solid-relay's invariant.

const plugin: Deno.lint.Plugin = {
  name: "hackerspub-solid-relay",
  rules: {
    "no-load-query-in-router-query": {
      create(context) {
        type ImportBinding =
          | { kind: "named"; imported: string }
          | { kind: "namespace" };

        const routerImports = new Map<string, ImportBinding>();
        const relayImports = new Map<string, ImportBinding>();
        const scopes: Set<string>[] = [];

        const pushScope = () => scopes.push(new Set());
        const popScope = () => scopes.pop();
        const recordBinding = (name: string) => {
          scopes[scopes.length - 1]?.add(name);
        };
        const isShadowed = (name: string) => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name)) return true;
          }
          return false;
        };
        const recordPatternBindings = (pattern: any) => {
          walkPatternIdentifiers(pattern, recordBinding);
        };
        const recordParamBindings = (params: any[] | undefined) => {
          for (const param of params ?? []) recordPatternBindings(param);
        };

        const isRouterQueryCall = (call: any): boolean => {
          const callee = call.callee;
          if (callee?.type === "Identifier") {
            if (isShadowed(callee.name)) return false;
            const binding = routerImports.get(callee.name);
            return binding?.kind === "named" && binding.imported === "query";
          }
          if (
            callee?.type === "MemberExpression" &&
            !callee.computed &&
            callee.object?.type === "Identifier" &&
            callee.property?.type === "Identifier"
          ) {
            if (isShadowed(callee.object.name)) return false;
            const binding = routerImports.get(callee.object.name);
            return binding?.kind === "namespace" &&
              callee.property.name === "query";
          }
          return false;
        };

        const message =
          "Do not call solid-relay loadQuery() inside @solidjs/router " +
          "query() fetchers. query() caches return values, but loadQuery() " +
          "returns a disposable PreloadedQuery that createPreloadedQuery() " +
          "disposes on unmount; reusing the cached object can crash with " +
          "solid-relay's disposed preloaded query invariant.";

        const isFunctionParent = (parent: any): boolean =>
          parent?.type === "ArrowFunctionExpression" ||
          parent?.type === "FunctionExpression" ||
          parent?.type === "FunctionDeclaration";

        return {
          Program: pushScope,
          "Program:exit": popScope,

          ImportDeclaration(node: any) {
            const source = node.source?.value;
            if (source !== "@solidjs/router" && source !== "solid-relay") {
              return;
            }
            const imports = source === "@solidjs/router"
              ? routerImports
              : relayImports;
            for (const spec of node.specifiers ?? []) {
              if (spec.type === "ImportSpecifier") {
                const local = spec.local?.name;
                const imported = spec.imported?.name ?? spec.imported?.value;
                if (typeof local === "string" && typeof imported === "string") {
                  imports.set(local, { kind: "named", imported });
                }
              } else if (spec.type === "ImportNamespaceSpecifier") {
                const local = spec.local?.name;
                if (typeof local === "string") {
                  imports.set(local, { kind: "namespace" });
                }
              }
            }
          },

          FunctionDeclaration(node: any) {
            if (node.id?.type === "Identifier") recordBinding(node.id.name);
            pushScope();
            recordParamBindings(node.params);
          },
          "FunctionDeclaration:exit": popScope,

          FunctionExpression(node: any) {
            pushScope();
            if (node.id?.type === "Identifier") recordBinding(node.id.name);
            recordParamBindings(node.params);
          },
          "FunctionExpression:exit": popScope,

          ArrowFunctionExpression(node: any) {
            pushScope();
            recordParamBindings(node.params);
          },
          "ArrowFunctionExpression:exit": popScope,

          BlockStatement(node: any) {
            if (isFunctionParent(node.parent)) return;
            pushScope();
            if (node.parent?.type === "CatchClause" && node.parent.param) {
              recordPatternBindings(node.parent.param);
            }
          },
          "BlockStatement:exit"(node: any) {
            if (!isFunctionParent(node.parent)) popScope();
          },

          VariableDeclarator(node: any) {
            recordPatternBindings(node.id);
          },

          CallExpression(node: any) {
            if (!isRouterQueryCall(node)) return;
            const fetcher = node.arguments?.[0];
            if (!isFunction(fetcher)) return;
            if (!functionContainsRelayLoadQuery(fetcher, relayImports)) return;

            context.report({
              node,
              message,
            });
          },
        };
      },
    },
  },
};

export default plugin;

function isFunction(node: any): boolean {
  return node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression";
}

function functionContainsRelayLoadQuery(
  fn: any,
  relayImports: Map<
    string,
    { kind: "named"; imported: string } | {
      kind: "namespace";
    }
  >,
): boolean {
  const scopes: Set<string>[] = [];
  const pushScope = () => scopes.push(new Set());
  const popScope = () => scopes.pop();
  const recordBinding = (name: string) => {
    scopes[scopes.length - 1]?.add(name);
  };
  const isShadowed = (name: string) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  };

  const recordPatternBindings = (pattern: any) => {
    walkPatternIdentifiers(pattern, recordBinding);
  };
  const recordParamBindings = (params: any[] | undefined) => {
    for (const param of params ?? []) recordPatternBindings(param);
  };

  const isRelayLoadQueryCall = (node: any): boolean => {
    if (node?.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee?.type === "Identifier") {
      if (isShadowed(callee.name)) return false;
      const binding = relayImports.get(callee.name);
      return binding?.kind === "named" && binding.imported === "loadQuery";
    }
    if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      callee.property?.type === "Identifier"
    ) {
      if (isShadowed(callee.object.name)) return false;
      const binding = relayImports.get(callee.object.name);
      return binding?.kind === "namespace" &&
        callee.property.name === "loadQuery";
    }
    return false;
  };

  const visit = (node: any): boolean => {
    if (!node || typeof node !== "object") return false;
    if (isRelayLoadQueryCall(node)) return true;

    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id?.type === "Identifier") recordBinding(node.id.name);
        pushScope();
        recordParamBindings(node.params);
        if (visit(node.body)) return true;
        popScope();
        return false;

      case "FunctionExpression":
      case "ArrowFunctionExpression":
        pushScope();
        if (node.id?.type === "Identifier") recordBinding(node.id.name);
        recordParamBindings(node.params);
        if (visit(node.body)) return true;
        popScope();
        return false;

      case "BlockStatement":
        pushScope();
        for (const stmt of node.body ?? []) {
          if (visit(stmt)) return true;
        }
        popScope();
        return false;

      case "VariableDeclarator":
        recordPatternBindings(node.id);
        return visit(node.init);

      case "ObjectExpression":
        for (const prop of node.properties ?? []) {
          if (prop.type === "SpreadElement" && visit(prop.argument)) {
            return true;
          }
          if (visit(prop.value)) return true;
        }
        return false;
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "parent" ||
        key === "range" ||
        key === "loc" ||
        key === "start" ||
        key === "end"
      ) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (visit(child)) return true;
        }
      } else if (value && typeof value === "object") {
        if (visit(value)) return true;
      }
    }
    return false;
  };

  pushScope();
  recordParamBindings(fn.params);
  const found = visit(fn.body);
  popScope();
  return found;
}

function walkPatternIdentifiers(
  pattern: any,
  bind: (name: string) => void,
): void {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      bind(pattern.name);
      return;
    case "AssignmentPattern":
      walkPatternIdentifiers(pattern.left, bind);
      return;
    case "RestElement":
      walkPatternIdentifiers(pattern.argument, bind);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements ?? []) {
        walkPatternIdentifiers(element, bind);
      }
      return;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        if (prop.type === "RestElement") {
          walkPatternIdentifiers(prop.argument, bind);
        } else {
          walkPatternIdentifiers(prop.value ?? prop.key, bind);
        }
      }
      return;
    case "TSParameterProperty":
      walkPatternIdentifiers(pattern.parameter, bind);
      return;
  }
}

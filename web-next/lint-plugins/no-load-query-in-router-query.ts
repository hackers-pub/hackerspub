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

const plugin = {
  meta: {
    name: "hackerspub-solid-relay",
  },
  name: "hackerspub-solid-relay",
  rules: {
    "no-load-query-in-router-query": {
      create(context: any) {
        type ImportBinding =
          | { kind: "named"; imported: string }
          | { kind: "namespace" };
        interface Scope {
          bindings: Set<string>;
          functions: Map<string, any>;
        }

        const routerImports = new Map<string, ImportBinding>();
        const relayImports = new Map<string, ImportBinding>();
        const scopes: Scope[] = [];

        const currentScope = () => scopes[scopes.length - 1];
        const pushScope = () =>
          scopes.push({ bindings: new Set(), functions: new Map() });
        const popScope = () => scopes.pop();
        const recordBinding = (name: string) => {
          currentScope()?.bindings.add(name);
        };
        const recordFunctionBinding = (name: string, fn: any) => {
          const scope = currentScope();
          scope?.bindings.add(name);
          scope?.functions.set(name, fn);
        };
        const isShadowed = (name: string) => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].bindings.has(name)) return true;
          }
          return false;
        };
        const resolveFunctionBinding = (name: string): any | undefined => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const fn = scopes[i].functions.get(name);
            if (fn != null) return fn;
            if (scopes[i].bindings.has(name)) return undefined;
          }
          return undefined;
        };
        const recordPatternBindings = (pattern: any) => {
          walkPatternIdentifiers(pattern, recordBinding);
        };
        const recordParamBindings = (params: any[] | undefined) => {
          for (const param of params ?? []) recordPatternBindings(param);
        };
        const predeclareScopeBindings = (body: any) => {
          for (const statement of body?.body ?? []) {
            predeclareStatementBinding(statement, recordBinding, (name, fn) => {
              recordFunctionBinding(name, fn);
            });
          }
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
            return (
              binding?.kind === "namespace" && callee.property.name === "query"
            );
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
          Program(node: any) {
            pushScope();
            predeclareScopeBindings(node);
          },
          "Program:exit": popScope,

          ImportDeclaration(node: any) {
            const source = node.source?.value;
            if (source !== "@solidjs/router" && source !== "solid-relay") {
              return;
            }
            const imports =
              source === "@solidjs/router" ? routerImports : relayImports;
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
            pushScope();
            recordParamBindings(node.params);
            predeclareScopeBindings(node.body);
          },
          "FunctionDeclaration:exit": popScope,

          FunctionExpression(node: any) {
            pushScope();
            if (node.id?.type === "Identifier") recordBinding(node.id.name);
            recordParamBindings(node.params);
            predeclareScopeBindings(node.body);
          },
          "FunctionExpression:exit": popScope,

          ArrowFunctionExpression(node: any) {
            pushScope();
            recordParamBindings(node.params);
            if (node.body?.type === "BlockStatement") {
              predeclareScopeBindings(node.body);
            }
          },
          "ArrowFunctionExpression:exit": popScope,

          BlockStatement(node: any) {
            if (isFunctionParent(node.parent)) return;
            pushScope();
            predeclareScopeBindings(node);
            if (node.parent?.type === "CatchClause" && node.parent.param) {
              recordPatternBindings(node.parent.param);
            }
          },
          "BlockStatement:exit"(node: any) {
            if (!isFunctionParent(node.parent)) popScope();
          },

          VariableDeclarator(node: any) {
            recordPatternBindings(node.id);
            if (node.id?.type === "Identifier" && isFunction(node.init)) {
              recordFunctionBinding(node.id.name, node.init);
            }
          },

          CallExpression(node: any) {
            if (!isRouterQueryCall(node)) return;
            const fetcher = node.arguments?.[0];
            const resolvedFetcher = isFunction(fetcher)
              ? fetcher
              : fetcher?.type === "Identifier"
                ? (resolveFunctionBinding(fetcher.name) ??
                  resolveFunctionBindingFromAncestors(fetcher.name, node))
                : undefined;
            if (!isFunction(resolvedFetcher)) return;
            if (
              !functionContainsRelayLoadQuery(resolvedFetcher, relayImports)
            ) {
              return;
            }

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
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function functionContainsRelayLoadQuery(
  fn: any,
  relayImports: Map<
    string,
    | { kind: "named"; imported: string }
    | {
        kind: "namespace";
      }
  >,
): boolean {
  interface Scope {
    bindings: Set<string>;
    functions: Map<string, any>;
  }

  const scopes: Scope[] = [];
  const currentScope = () => scopes[scopes.length - 1];
  const pushScope = () =>
    scopes.push({ bindings: new Set(), functions: new Map() });
  const popScope = () => scopes.pop();
  const recordBinding = (name: string) => {
    currentScope()?.bindings.add(name);
  };
  const recordFunctionBinding = (name: string, fn: any) => {
    const scope = currentScope();
    scope?.bindings.add(name);
    scope?.functions.set(name, fn);
  };
  const resolveFunctionBinding = (
    name: string,
  ): { found: boolean; fn?: any } => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const fn = scopes[i].functions.get(name);
      if (fn != null) return { found: true, fn };
      if (scopes[i].bindings.has(name)) return { found: true };
    }
    return { found: false };
  };
  const isShadowed = (name: string) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].bindings.has(name)) return true;
    }
    return false;
  };

  const recordPatternBindings = (pattern: any) => {
    walkPatternIdentifiers(pattern, recordBinding);
  };
  const recordParamBindings = (params: any[] | undefined) => {
    for (const param of params ?? []) recordPatternBindings(param);
  };
  const predeclareScopeBindings = (body: any) => {
    for (const statement of body?.body ?? []) {
      predeclareStatementBinding(statement, recordBinding, (name, fn) => {
        recordFunctionBinding(name, fn);
      });
    }
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
      return (
        binding?.kind === "namespace" && callee.property.name === "loadQuery"
      );
    }
    return false;
  };

  const visitedFunctions = new Set<any>();

  const resolveCalledFunction = (call: any): any | undefined => {
    if (call.callee?.type !== "Identifier") return undefined;

    const binding = resolveFunctionBinding(call.callee.name);
    if (binding.found) return binding.fn;
    return resolveFunctionBindingFromAncestors(call.callee.name, call);
  };

  const visitFunction = (node: any): boolean => {
    if (visitedFunctions.has(node)) return false;
    visitedFunctions.add(node);

    pushScope();
    if (node.type !== "FunctionDeclaration" && node.id?.type === "Identifier") {
      recordBinding(node.id.name);
    }
    recordParamBindings(node.params);
    if (node.body?.type === "BlockStatement") {
      predeclareScopeBindings(node.body);
    }
    const found = visit(node.body);
    popScope();
    return found;
  };

  const visit = (node: any): boolean => {
    if (!node || typeof node !== "object") return false;
    if (isRelayLoadQueryCall(node)) return true;

    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return visitFunction(node);

      case "BlockStatement":
        pushScope();
        predeclareScopeBindings(node);
        for (const stmt of node.body ?? []) {
          if (visit(stmt)) return true;
        }
        popScope();
        return false;

      case "VariableDeclarator":
        recordPatternBindings(node.id);
        if (node.id?.type === "Identifier" && isFunction(node.init)) {
          recordFunctionBinding(node.id.name, node.init);
        }
        return visit(node.init);

      case "ReturnStatement":
      case "ExpressionStatement":
        return visit(node.argument ?? node.expression);

      case "CallExpression":
        if (visit(resolveCalledFunction(node))) return true;
        if (visit(node.callee)) return true;
        for (const arg of node.arguments ?? []) {
          if (visit(arg)) return true;
        }
        return false;

      case "AwaitExpression":
      case "ChainExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        return visit(node.argument ?? node.expression);

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
      ) {
        continue;
      }
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
  if (fn.body?.type === "BlockStatement") {
    predeclareScopeBindings(fn.body);
  }
  const found = visit(fn.body);
  popScope();
  return found;
}

function predeclareStatementBinding(
  statement: any,
  recordBinding: (name: string) => void,
  recordFunctionBinding?: (name: string, fn: any) => void,
): void {
  switch (statement?.type) {
    case "FunctionDeclaration":
      if (statement.id?.type === "Identifier") {
        recordFunctionBinding?.(statement.id.name, statement);
        if (recordFunctionBinding == null) recordBinding(statement.id.name);
      }
      return;
    case "VariableDeclaration":
      for (const declaration of statement.declarations ?? []) {
        walkPatternIdentifiers(declaration.id, recordBinding);
        if (
          declaration.id?.type === "Identifier" &&
          isFunction(declaration.init)
        ) {
          recordFunctionBinding?.(declaration.id.name, declaration.init);
        }
      }
      return;
    case "ClassDeclaration":
      if (statement.id?.type === "Identifier") recordBinding(statement.id.name);
      return;
  }
}

function resolveFunctionBindingFromAncestors(
  name: string,
  node: any,
): any | undefined {
  for (let current = node?.parent; current; current = current.parent) {
    const body = scopeStatements(current);
    if (body == null) continue;
    const binding = findFunctionBindingInStatements(name, body);
    if (binding.found) return binding.fn;
  }
  return undefined;
}

function scopeStatements(node: any): any[] | undefined {
  if (node?.type === "Program") return node.body;
  if (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  ) {
    return node.body?.type === "BlockStatement" ? node.body.body : undefined;
  }
  if (node?.type === "BlockStatement" && !isFunction(node.parent)) {
    return node.body;
  }
  return undefined;
}

function findFunctionBindingInStatements(
  name: string,
  statements: any[],
): { found: boolean; fn?: any } {
  for (const statement of statements ?? []) {
    if (
      statement?.type === "FunctionDeclaration" &&
      statement.id?.name === name
    ) {
      return { found: true, fn: statement };
    }
    if (statement?.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations ?? []) {
      if (!patternContainsIdentifier(declaration.id, name)) continue;
      return {
        found: true,
        fn:
          declaration.id?.type === "Identifier" && isFunction(declaration.init)
            ? declaration.init
            : undefined,
      };
    }
  }
  return { found: false };
}

function patternContainsIdentifier(pattern: any, name: string): boolean {
  let found = false;
  walkPatternIdentifiers(pattern, (identifier) => {
    if (identifier === name) found = true;
  });
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

// deno-lint-ignore-file no-explicit-any
//
// Custom Deno lint plugin: enforce `<Show keyed>` and `<Match keyed>` when
// the gated value comes from a solid-relay primitive and the children is a
// function with arity ≥ 1.
//
// Why scoped to Relay: Solid's non-keyed `<Show when={x}>{(value) => ...}`
// passes a guarded accessor that throws "Stale read from <Show>" when
// invoked while the condition is falsy. solid-relay publishes fragment
// snapshots inside `batch()`, so descendant reactive computations sharing
// dependencies with the gated field can race with the Show's own
// re-evaluation and trip that throw. With `keyed`, the children receives
// the value directly — no guarded accessor, no stale-read race. Reconcile
// keeps record identity stable (`key: "__id"`), so `keyed` only re-mounts
// on actual record changes.
//
// For non-Relay reactive values the same theoretical race exists but in
// practice is rare and the cost/benefit of forcing `keyed` (which would
// re-mount children whenever the value's identity changes) doesn't favour
// blanket conversion. So we only flag Shows whose `when` traces back to a
// solid-relay primitive within the current lexical scope.
//
// What counts as Relay-backed:
//   1. A binding `const x = createPreloadedQuery(...)` (or any of the
//      tracked solid-relay primitives, named OR via namespace import).
//   2. A first-param binding inside the children of a Show/Match whose
//      own `when` was Relay-backed — i.e., propagation through nested
//      Show callbacks.
//
// The autofix:
//   - Inserts `keyed` on the opening element.
//   - Replaces bare `param()` calls in the children body with `param`,
//     respecting same-name lexical re-bindings (skips body rewrite when
//     any rebind exists; only inserts `keyed`).
//   - Skips autofix entirely when the element already has a non-truthy
//     `keyed` attribute (`keyed={false}`, `keyed={someVar}`, …) so we
//     don't end up with `<Show keyed keyed={false}>`.

const TARGET_TAGS = new Set(["Show", "Match"]);

const RELAY_PRIMITIVES = new Set([
  "createPreloadedQuery",
  "createFragment",
  "createPaginationFragment",
  "createRefetchableFragment",
  "createLazyLoadQuery",
  "createSubscription",
  "createQueryLoader",
]);

type ShowEntry = {
  openingName: any;
  paramName: string | null;
  fnExpr: any;
  bodyHasRebinding: boolean;
  existingKeyedAttr: any | null;
  // True when the body uses the param in a way that the value-form
  // rewrite cannot safely express. The only safe forms are zero-argument
  // calls (`param()` or `param?.()`) which are explicitly rewritten in
  // `calls`. A non-zero-argument call (`param(arg)`) on the param would
  // turn into `param(arg)` after the keyed flip, calling the now-keyed
  // value as a function with arguments and crashing at runtime.
  hasUnsafeParamUse: boolean;
  calls: any[];
  reported: boolean;
};

const plugin = {
  meta: {
    name: "hackerspub-solid",
  },
  name: "hackerspub-solid",
  rules: {
    "show-keyed-on-fn-child": {
      meta: {
        fixable: "code",
      },
      create(context: any) {
        // Stack of lexical scopes. Each entry maps an identifier name to
        // either "relay" (a binding known to come from a solid-relay
        // primitive) or "shadow" (any other binding for that name). Lookup
        // walks bottom-up; the innermost binding wins, so a non-Relay
        // shadow in an inner scope correctly hides an outer Relay binding.
        type BindingKind = "relay" | "shadow";
        const scopes: Map<string, BindingKind>[] = [];
        const pushScope = () => scopes.push(new Map());
        const popScope = () => scopes.pop();
        const recordBinding = (name: string, kind: BindingKind) => {
          const top = scopes[scopes.length - 1];
          if (!top) return;
          // Don't downgrade a "relay" already present in the same scope.
          if (top.get(name) === "relay" && kind === "shadow") return;
          top.set(name, kind);
        };
        const isRelayBacked = (name: string): boolean => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const kind = scopes[i].get(name);
            if (kind != null) return kind === "relay";
          }
          return false;
        };
        // Returns the innermost binding kind for `name` in the current
        // scope chain, or null if no scope binds it. The scope chain at
        // any visit reflects the call site's actual lexical scope, so
        // sibling-block declarations that have already been popped do
        // not leak into the answer.
        const lookupBinding = (name: string): BindingKind | null => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            const kind = scopes[i].get(name);
            if (kind != null) return kind;
          }
          return null;
        };

        const shows = new Map<any, ShowEntry>();

        // Names imported from "solid-relay". For named imports we record
        // the local binding -> { kind: "named", imported }; for namespace
        // imports we record the local binding -> { kind: "namespace" }.
        // Only references resolved through one of these bindings count as
        // a Relay primitive call.
        type RelayImport =
          | { kind: "named"; imported: string }
          | { kind: "namespace" };
        const relayImports = new Map<string, RelayImport>();

        const message =
          "Use <Show keyed>/<Match keyed> when the children is a function " +
          "and the gated value comes from solid-relay (createFragment / " +
          "createPreloadedQuery / etc.). solid-relay publishes snapshots " +
          "inside batch(), so a non-keyed accessor can throw 'Stale read " +
          "from <Show>' if the value flips to null in the same tick as a " +
          "downstream reactive read. With keyed, the children receives the " +
          "value directly; reconcile keeps record identity stable, so " +
          "keyed only re-mounts on actual record changes.";

        // Walk a destructuring/identifier pattern and record every name
        // it introduces with the given kind.
        const recordPatternBindings = (
          pattern: any,
          kind: BindingKind,
        ): void => {
          walkPatternIdentifiers(pattern, (name) => recordBinding(name, kind));
        };

        // Record every parameter of a function as a "shadow" binding in
        // the current (just-pushed) scope. The Show propagation step may
        // upgrade the first param to "relay" afterward.
        const recordParamShadows = (params: any[] | undefined): void => {
          for (const p of params ?? []) {
            recordPatternBindings(p, "shadow");
          }
        };

        // Shared by ArrowFunctionExpression and FunctionExpression: when
        // the function is the children of a Show/Match whose `when` is
        // Relay-backed in the OUTER scope, mark the function's first
        // param as Relay-backed in the new (just-pushed) scope.
        const propagateRelayBindingFromShowParent = (node: any): void => {
          const exprContainer = node.parent;
          if (exprContainer?.type !== "JSXExpressionContainer") return;
          const showJsx = exprContainer.parent;
          if (showJsx?.type !== "JSXElement") return;
          const opening = showJsx.openingElement;
          const tagName = opening?.name;
          if (
            tagName?.type !== "JSXIdentifier" ||
            !TARGET_TAGS.has(tagName.name)
          ) {
            return;
          }
          const whenExpr = getWhenExpression(opening);
          if (!whenExpr) return;
          const top = scopes.pop();
          const outerSays = expressionIsRelayBacked(whenExpr, isRelayBacked);
          if (top) scopes.push(top);
          if (!outerSays) return;
          const firstParam = node.params?.[0];
          if (firstParam?.type === "Identifier") {
            recordBinding(firstParam.name, "relay");
          }
        };

        // Verify the call's callee resolves through a tracked solid-relay
        // import binding before claiming it's a Relay primitive call.
        // Rejects the call when a closer lexical binding (any kind) for
        // the identifier exists, so a local shadow does not get
        // misclassified as the import. The shadow check uses the active
        // `scopes` stack, which already reflects the call's true lexical
        // scope (sibling blocks have been pushed-and-popped, so they do
        // not leak in).
        const isRelayPrimitiveCallResolved = (call: any): boolean => {
          const callee = call.callee;
          if (!callee) return false;
          let bindingName: string;
          if (callee.type === "Identifier") {
            const imp = relayImports.get(callee.name);
            if (
              !(imp?.kind === "named" && RELAY_PRIMITIVES.has(imp.imported))
            ) {
              return false;
            }
            bindingName = callee.name;
          } else if (callee.type === "MemberExpression" && !callee.computed) {
            const prop = callee.property;
            if (prop?.type !== "Identifier") return false;
            if (!RELAY_PRIMITIVES.has(prop.name)) return false;
            const obj = callee.object;
            if (obj?.type !== "Identifier") return false;
            const imp = relayImports.get(obj.name);
            if (imp?.kind !== "namespace") return false;
            bindingName = obj.name;
          } else {
            return false;
          }
          // Closer lexical binding wins over the module-level import.
          if (lookupBinding(bindingName) != null) return false;
          // Named FunctionExpression / FunctionDeclaration self-binding
          // is visible inside the function's own body. The `scopes` stack
          // does not record FunctionExpression ids (they don't
          // necessarily survive past the literal), so we walk enclosing
          // functions to handle this corner case explicitly.
          let cursor = call.parent;
          while (cursor) {
            if (
              (cursor.type === "FunctionExpression" ||
                cursor.type === "FunctionDeclaration") &&
              cursor.id?.type === "Identifier" &&
              cursor.id.name === bindingName
            ) {
              return false;
            }
            cursor = cursor.parent;
          }
          return true;
        };

        // Shared handler for `value()` and `value?.()`. Walks up to the
        // nearest function scope that binds `calleeName` as a param; if
        // that function is a tracked Show callback, records the call for
        // rewrite (zero-arg, no body rebinding) or marks the param use
        // as unsafe (any non-zero-arg invocation).
        const handleParamCall = (node: any): void => {
          const callee = node.callee;
          if (callee?.type !== "Identifier") return;
          const argCount = node.arguments?.length ?? 0;
          const calleeName: string = callee.name;

          let cursor: any = node.parent;
          while (cursor) {
            const fn =
              cursor.type === "ArrowFunctionExpression" ||
              cursor.type === "FunctionExpression" ||
              cursor.type === "FunctionDeclaration";
            if (fn) {
              if (paramRebindsName(cursor.params, calleeName)) {
                const entry = shows.get(cursor);
                if (entry && entry.paramName === calleeName) {
                  if (argCount === 0 && !entry.bodyHasRebinding) {
                    entry.calls.push(node);
                  } else if (argCount > 0) {
                    entry.hasUnsafeParamUse = true;
                  }
                }
                return;
              }
            }
            cursor = cursor.parent;
          }
        };

        // BlockStatement push/pop. Function bodies are themselves
        // BlockStatements, but the enclosing function visitor has already
        // pushed a scope for them, so we skip the BlockStatement push for
        // a node whose parent is a function. Every other block (an `if`,
        // `for`, `while`, plain `{ ... }`, or `try`/`finally` body) gets
        // its own block scope so block-scoped `let`/`const` bindings stay
        // local and shadow outer same-name bindings as expected.
        const isFunctionParent = (parent: any): boolean =>
          parent?.type === "ArrowFunctionExpression" ||
          parent?.type === "FunctionExpression" ||
          parent?.type === "FunctionDeclaration";

        return {
          Program: pushScope,
          "Program:exit": popScope,
          FunctionDeclaration(node: any) {
            // The function id binds in the *enclosing* scope (record before
            // pushing the function's own scope).
            if (node.id?.type === "Identifier") {
              recordBinding(node.id.name, "shadow");
            }
            pushScope();
            recordParamShadows(node.params);
          },
          "FunctionDeclaration:exit": popScope,
          FunctionExpression(node: any) {
            pushScope();
            recordParamShadows(node.params);
            propagateRelayBindingFromShowParent(node);
          },
          "FunctionExpression:exit": popScope,
          BlockStatement(node: any) {
            if (isFunctionParent(node.parent)) return;
            pushScope();
            // If this is a catch-clause body, hoist the catch param into
            // the just-pushed block scope so `e` in `catch (e) { ... }`
            // shadows outer bindings inside the catch body.
            if (node.parent?.type === "CatchClause" && node.parent.param) {
              recordPatternBindings(node.parent.param, "shadow");
            }
          },
          "BlockStatement:exit"(node: any) {
            if (!isFunctionParent(node.parent)) popScope();
          },

          ImportDeclaration(node: any) {
            if (node.source?.value !== "solid-relay") return;
            for (const spec of node.specifiers ?? []) {
              if (spec.type === "ImportSpecifier") {
                const local = spec.local?.name;
                const imported = spec.imported?.name ?? spec.imported?.value;
                if (typeof local === "string" && typeof imported === "string") {
                  relayImports.set(local, { kind: "named", imported });
                }
              } else if (spec.type === "ImportNamespaceSpecifier") {
                const local = spec.local?.name;
                if (typeof local === "string") {
                  relayImports.set(local, { kind: "namespace" });
                }
              }
            }
          },

          ArrowFunctionExpression(node: any) {
            pushScope();
            recordParamShadows(node.params);
            propagateRelayBindingFromShowParent(node);
          },
          "ArrowFunctionExpression:exit": popScope,

          VariableDeclarator(node: any) {
            const init = node.init;
            const relay =
              init?.type === "CallExpression" &&
              isRelayPrimitiveCallResolved(init);
            // Record the binding either way: relay if the init is a tracked
            // solid-relay primitive call, shadow otherwise. Recording shadow
            // bindings lets isRelayBacked detect when a closer scope hides
            // an outer Relay-backed name.
            recordPatternBindings(node.id, relay ? "relay" : "shadow");
          },

          JSXElement(node: any) {
            const opening = node.openingElement;
            const name = opening?.name;
            if (name?.type !== "JSXIdentifier") return;
            if (!TARGET_TAGS.has(name.name)) return;

            // Only flag when `when` is Relay-backed.
            const whenExpr = getWhenExpression(opening);
            if (!whenExpr) return;
            if (!expressionIsRelayBacked(whenExpr, isRelayBacked)) return;

            // Skip if explicitly-truthy `keyed` is already present.
            let existingKeyedAttr: any | null = null;
            for (const attr of opening.attributes ?? []) {
              if (
                attr.type === "JSXAttribute" &&
                attr.name?.type === "JSXIdentifier" &&
                attr.name.name === "keyed"
              ) {
                if (isStaticTrueAttribute(attr)) return;
                existingKeyedAttr = attr;
              }
            }

            // Find a function child with arity ≥ 1.
            let fnExpr: any | undefined;
            for (const child of node.children ?? []) {
              if (
                child.type === "JSXExpressionContainer" &&
                (child.expression?.type === "ArrowFunctionExpression" ||
                  child.expression?.type === "FunctionExpression") &&
                child.expression.params.length >= 1
              ) {
                fnExpr = child.expression;
                break;
              }
            }
            if (!fnExpr) return;

            const param = fnExpr.params[0];
            const paramName: string | null =
              param?.type === "Identifier" ? param.name : null;

            const bodyHasRebinding =
              paramName == null
                ? false
                : detectRebinding(fnExpr.body, paramName);

            shows.set(fnExpr, {
              openingName: name,
              paramName,
              fnExpr,
              bodyHasRebinding,
              existingKeyedAttr,
              hasUnsafeParamUse: false,
              calls: [],
              reported: false,
            });
          },

          // Both bare `value()` and optional `value?.()` calls need the
          // same handling. In deno_ast, `value?.()` is a `CallExpression`
          // with `optional: true` (wrapped in a `ChainExpression`), so
          // the `CallExpression` visitor below already catches both. The
          // `OptionalCallExpression` visitor is wired defensively in case
          // a future AST revision splits them out: same handler, no-op
          // today. Either way, the CallExpression's range covers the
          // entire `value?.()` text, so the autofix replaces uniformly.
          CallExpression(node: any) {
            handleParamCall(node);
          },
          OptionalCallExpression(node: any) {
            handleParamCall(node);
          },

          "JSXElement:exit"(node: any) {
            const opening = node.openingElement;
            const name = opening?.name;
            if (name?.type !== "JSXIdentifier") return;
            if (!TARGET_TAGS.has(name.name)) return;

            // Mirror the entry-side selection (arity ≥ 1) so a Show with
            // a leading zero-arity child followed by a real callback still
            // resolves to the same fnExpr that JSXElement(node) recorded.
            let fnExpr: any | undefined;
            for (const child of node.children ?? []) {
              if (
                child.type === "JSXExpressionContainer" &&
                (child.expression?.type === "ArrowFunctionExpression" ||
                  child.expression?.type === "FunctionExpression") &&
                child.expression.params.length >= 1
              ) {
                fnExpr = child.expression;
                break;
              }
            }
            const entry = fnExpr ? shows.get(fnExpr) : undefined;
            if (!entry || entry.reported) return;
            entry.reported = true;

            const { openingName, paramName, calls, existingKeyedAttr } = entry;

            // Skip autofix when we can't safely rewrite the body:
            //   - existing non-truthy `keyed={...}` (don't know intent), or
            //   - body has a same-name lexical rebinding (we conservatively
            //     skip the param() replacements, but inserting `keyed`
            //     alone would leave any non-shadowed `param()` calls
            //     pointing at the now-keyed value, which is no longer a
            //     function and would throw at runtime), or
            //   - body uses the param in a way the rewrite cannot express
            //     safely (e.g., `param(arg)` with non-zero arguments).
            if (
              existingKeyedAttr ||
              entry.bodyHasRebinding ||
              entry.hasUnsafeParamUse
            ) {
              context.report({ node: opening, message });
              return;
            }

            context.report({
              node: opening,
              message,
              fix(fixer: any) {
                const fixes: any[] = [];
                fixes.push(
                  fixer.insertTextAfterRange(
                    openingName.range as [number, number],
                    " keyed",
                  ),
                );
                if (paramName) {
                  for (const call of calls) {
                    fixes.push(
                      fixer.replaceTextRange(
                        call.range as [number, number],
                        paramName,
                      ),
                    );
                  }
                }
                return fixes;
              },
            });
          },
        };
      },
    },
  },
};

// Get the `when` JSX attribute's expression, if any.
function getWhenExpression(opening: any): any | null {
  for (const attr of opening?.attributes ?? []) {
    if (
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === "when" &&
      attr.value?.type === "JSXExpressionContainer"
    ) {
      return attr.value.expression;
    }
  }
  return null;
}

// Walk a destructuring pattern and invoke `bind` for every identifier it
// introduces.
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
      for (const e of pattern.elements ?? []) walkPatternIdentifiers(e, bind);
      return;
    case "ObjectPattern":
      for (const p of pattern.properties ?? []) {
        if (p.type === "RestElement") {
          walkPatternIdentifiers(p.argument, bind);
        } else if (p.type === "Property") {
          walkPatternIdentifiers(p.value, bind);
        }
      }
      return;
  }
}

// Walk an expression and check whether any free identifier in it is
// considered Relay-backed by the supplied resolver. Descends only through
// expression positions (skips function bodies and non-computed member
// property names) so that we don't drag in unrelated identifiers.
function expressionIsRelayBacked(
  expr: any,
  isRelayBacked: (name: string) => boolean,
): boolean {
  const stack: any[] = [expr];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      continue;
    }
    if (node.type === "Identifier") {
      if (isRelayBacked(node.name)) return true;
      continue;
    }
    switch (node.type) {
      case "CallExpression":
      case "NewExpression":
        stack.push(node.callee);
        for (const a of node.arguments ?? []) stack.push(a);
        break;
      case "OptionalCallExpression":
        stack.push(node.callee);
        for (const a of node.arguments ?? []) stack.push(a);
        break;
      case "MemberExpression":
      case "OptionalMemberExpression":
        stack.push(node.object);
        if (node.computed) stack.push(node.property);
        break;
      case "ChainExpression":
        stack.push(node.expression);
        break;
      case "BinaryExpression":
      case "LogicalExpression":
      case "AssignmentExpression":
        stack.push(node.left);
        stack.push(node.right);
        break;
      case "ConditionalExpression":
        stack.push(node.test);
        stack.push(node.consequent);
        stack.push(node.alternate);
        break;
      case "UnaryExpression":
      case "UpdateExpression":
      case "AwaitExpression":
      case "YieldExpression":
      case "SpreadElement":
        if (node.argument) stack.push(node.argument);
        break;
      case "ArrayExpression":
        for (const e of node.elements ?? []) stack.push(e);
        break;
      case "ObjectExpression":
        for (const p of node.properties ?? []) stack.push(p);
        break;
      case "Property":
        if (node.computed) stack.push(node.key);
        stack.push(node.value);
        break;
      case "TemplateLiteral":
        for (const e of node.expressions ?? []) stack.push(e);
        break;
      case "TaggedTemplateExpression":
        stack.push(node.tag);
        stack.push(node.quasi);
        break;
      case "SequenceExpression":
        for (const e of node.expressions ?? []) stack.push(e);
        break;
      case "ImportExpression":
        stack.push(node.source);
        break;
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
        stack.push(node.expression);
        break;
      case "ParenthesizedExpression":
        stack.push(node.expression);
        break;
      // Don't descend into function bodies — they introduce new scopes
      // and free-variable analysis there isn't trivial.
    }
  }
  return false;
}

function isStaticTrueAttribute(attr: any): boolean {
  if (attr.value == null) return true;
  const v = attr.value;
  if (v.type === "JSXExpressionContainer") {
    const expr = v.expression;
    if (expr?.type === "Literal" && expr.value === true) return true;
    if (expr?.type === "BooleanLiteral" && expr.value === true) return true;
  }
  return false;
}

function paramRebindsName(params: any[] | undefined, name: string): boolean {
  for (const p of params ?? []) if (paramRebinds(p, name)) return true;
  return false;
}

function paramRebinds(param: any, name: string): boolean {
  if (!param || typeof param !== "object") return false;
  switch (param.type) {
    case "Identifier":
      return param.name === name;
    case "AssignmentPattern":
      return paramRebinds(param.left, name);
    case "RestElement":
      return paramRebinds(param.argument, name);
    case "ArrayPattern":
      return (param.elements ?? []).some((e: any) => paramRebinds(e, name));
    case "ObjectPattern":
      return (param.properties ?? []).some((p: any) => {
        if (p.type === "RestElement") return paramRebinds(p.argument, name);
        if (p.type === "Property") return paramRebinds(p.value, name);
        return false;
      });
    default:
      return false;
  }
}

// Same as before — conservatively detect any same-name binder anywhere in
// the body subtree to suppress the body rewrite.
interface DetectRebindingOptions {
  // When false, the walker stops at nested ArrowFunctionExpression /
  // FunctionExpression / FunctionDeclaration boundaries (it doesn't
  // descend into their bodies). Default true preserves the original
  // conservative behaviour used by the body-rebinding check.
  enterNestedFunctions?: boolean;
}

// Per-node-type child-field map used by `detectRebinding` to walk the
// AST manually. Hoisted to module scope so it isn't re-allocated on
// every call.
const DETECT_REBINDING_FIELDS: Record<string, readonly string[]> = {
  BlockStatement: ["body"],
  ExpressionStatement: ["expression"],
  IfStatement: ["test", "consequent", "alternate"],
  SwitchStatement: ["discriminant", "cases"],
  SwitchCase: ["test", "consequent"],
  ForStatement: ["init", "test", "update", "body"],
  ForInStatement: ["left", "right", "body"],
  ForOfStatement: ["left", "right", "body"],
  WhileStatement: ["test", "body"],
  DoWhileStatement: ["test", "body"],
  ReturnStatement: ["argument"],
  ThrowStatement: ["argument"],
  TryStatement: ["block", "handler", "finalizer"],
  CatchClause: ["param", "body"],
  LabeledStatement: ["body"],
  WithStatement: ["object", "body"],
  VariableDeclaration: ["declarations"],
  VariableDeclarator: ["id", "init"],
  FunctionDeclaration: ["id", "params", "body"],
  FunctionExpression: ["id", "params", "body"],
  ArrowFunctionExpression: ["params", "body"],
  ClassDeclaration: ["id", "superClass", "body"],
  ClassExpression: ["id", "superClass", "body"],
  ClassBody: ["body"],
  MethodDefinition: ["key", "value"],
  PropertyDefinition: ["key", "value"],
  StaticBlock: ["body"],
  CallExpression: ["callee", "arguments"],
  NewExpression: ["callee", "arguments"],
  MemberExpression: ["object", "property"],
  AssignmentExpression: ["left", "right"],
  UpdateExpression: ["argument"],
  BinaryExpression: ["left", "right"],
  LogicalExpression: ["left", "right"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  UnaryExpression: ["argument"],
  SequenceExpression: ["expressions"],
  ArrayExpression: ["elements"],
  ObjectExpression: ["properties"],
  Property: ["key", "value"],
  SpreadElement: ["argument"],
  TemplateLiteral: ["expressions", "quasis"],
  TaggedTemplateExpression: ["tag", "quasi"],
  YieldExpression: ["argument"],
  AwaitExpression: ["argument"],
  ChainExpression: ["expression"],
  OptionalCallExpression: ["callee", "arguments"],
  OptionalMemberExpression: ["object", "property"],
  ImportExpression: ["source"],
  JSXElement: ["openingElement", "closingElement", "children"],
  JSXFragment: ["openingFragment", "closingFragment", "children"],
  JSXOpeningElement: ["name", "attributes"],
  JSXClosingElement: ["name"],
  JSXAttribute: ["name", "value"],
  JSXSpreadAttribute: ["argument"],
  JSXExpressionContainer: ["expression"],
  JSXSpreadChild: ["expression"],
  ArrayPattern: ["elements"],
  ObjectPattern: ["properties"],
  RestElement: ["argument"],
  AssignmentPattern: ["left", "right"],
  TSAsExpression: ["expression", "typeAnnotation"],
  TSNonNullExpression: ["expression"],
  TSSatisfiesExpression: ["expression", "typeAnnotation"],
  TSTypeAssertion: ["expression", "typeAnnotation"],
};

function detectRebinding(
  root: any,
  name: string,
  options: DetectRebindingOptions = {},
): boolean {
  const enterNestedFunctions = options.enterNestedFunctions ?? true;

  const stack: any[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node.type !== "string") continue;

    if (node.type === "VariableDeclarator" && bindsName(node.id, name)) {
      return true;
    }
    if (node.type === "CatchClause" && bindsName(node.param, name)) {
      return true;
    }
    // `value = ...` (including destructuring `[value] = ...` /
    // `({ value } = ...)`) reassigns the param itself; after the keyed
    // flip the body would carry the reassigned value rather than the
    // keyed one, so the autofix can't safely rewrite calls below the
    // assignment. `value++` / `value--` mutate the binding the same way.
    if (node.type === "AssignmentExpression" && bindsName(node.left, name)) {
      return true;
    }
    if (
      node.type === "UpdateExpression" &&
      node.argument?.type === "Identifier" &&
      node.argument.name === name
    ) {
      return true;
    }
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression") &&
      node.id?.type === "Identifier" &&
      node.id.name === name
    ) {
      return true;
    }
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      paramRebindsName(node.params, name)
    ) {
      return true;
    }

    // When `enterNestedFunctions` is false and we're standing on a
    // nested function/arrow node that is not the root, skip descending
    // into it so its inner bindings don't count as shadowing the call
    // site outside the function.
    if (
      !enterNestedFunctions &&
      node !== root &&
      (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration")
    ) {
      continue;
    }

    const fields = DETECT_REBINDING_FIELDS[node.type];
    if (fields) {
      for (const f of fields) {
        const v = node[f];
        if (v != null) stack.push(v);
      }
    }
  }
  return false;
}

function bindsName(pattern: any, name: string): boolean {
  if (!pattern || typeof pattern !== "object") return false;
  switch (pattern.type) {
    case "Identifier":
      return pattern.name === name;
    case "AssignmentPattern":
      return bindsName(pattern.left, name);
    case "RestElement":
      return bindsName(pattern.argument, name);
    case "ArrayPattern":
      return (pattern.elements ?? []).some((e: any) => bindsName(e, name));
    case "ObjectPattern":
      return (pattern.properties ?? []).some((p: any) => {
        if (p.type === "RestElement") return bindsName(p.argument, name);
        if (p.type === "Property") return bindsName(p.value, name);
        return false;
      });
    default:
      return false;
  }
}

export default plugin;

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
  calls: any[];
  reported: boolean;
};

const plugin: Deno.lint.Plugin = {
  name: "hackerspub-solid",
  rules: {
    "show-keyed-on-fn-child": {
      create(context) {
        // Stack of lexical scopes. Each entry is the set of identifier names
        // known to be Relay-backed in that scope. Lookup walks bottom-up.
        const scopes: Set<string>[] = [];
        const pushScope = () => scopes.push(new Set());
        const popScope = () => scopes.pop();
        const addToCurrentScope = (name: string) => {
          scopes[scopes.length - 1]?.add(name);
        };
        const isRelayBacked = (name: string): boolean => {
          for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name)) return true;
          }
          return false;
        };

        const shows = new Map<any, ShowEntry>();

        const message =
          "Use <Show keyed>/<Match keyed> when the children is a function " +
          "and the gated value comes from solid-relay (createFragment / " +
          "createPreloadedQuery / etc.). solid-relay publishes snapshots " +
          "inside batch(), so a non-keyed accessor can throw 'Stale read " +
          "from <Show>' if the value flips to null in the same tick as a " +
          "downstream reactive read. With keyed, the children receives the " +
          "value directly; reconcile keeps record identity stable, so " +
          "keyed only re-mounts on actual record changes.";

        return {
          Program: pushScope,
          "Program:exit": popScope,
          FunctionDeclaration: pushScope,
          "FunctionDeclaration:exit": popScope,
          FunctionExpression: pushScope,
          "FunctionExpression:exit": popScope,

          ArrowFunctionExpression(node: any) {
            pushScope();
            // If this arrow is the children of a Show/Match whose `when` is
            // Relay-backed, the arrow's first param carries Relay-backed-
            // ness into the body. (We check Relay-backed-ness of `when`
            // against the OUTER scope, which is still the second-to-top of
            // the stack at this point.)
            const exprContainer = node.parent;
            if (exprContainer?.type !== "JSXExpressionContainer") return;
            const showJsx = exprContainer.parent;
            if (showJsx?.type !== "JSXElement") return;
            const opening = showJsx.openingElement;
            const tagName = opening?.name;
            if (
              tagName?.type !== "JSXIdentifier" ||
              !TARGET_TAGS.has(tagName.name)
            ) return;
            const whenExpr = getWhenExpression(opening);
            if (!whenExpr) return;
            // Evaluate Relay-backed-ness against the outer scope only.
            const top = scopes.pop();
            const outerSays = expressionIsRelayBacked(whenExpr, isRelayBacked);
            if (top) scopes.push(top);
            if (!outerSays) return;
            const firstParam = node.params?.[0];
            if (firstParam?.type === "Identifier") {
              addToCurrentScope(firstParam.name);
            }
          },
          "ArrowFunctionExpression:exit": popScope,

          VariableDeclarator(node: any) {
            const init = node.init;
            if (init?.type === "CallExpression" && isRelayPrimitiveCall(init)) {
              bindIdentifiersAsRelay(node.id, addToCurrentScope);
            }
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
            const paramName: string | null = param?.type === "Identifier"
              ? param.name
              : null;

            const bodyHasRebinding = paramName == null
              ? false
              : detectRebinding(fnExpr.body, paramName);

            shows.set(fnExpr, {
              openingName: name,
              paramName,
              fnExpr,
              bodyHasRebinding,
              existingKeyedAttr,
              calls: [],
              reported: false,
            });
          },

          CallExpression(node: any) {
            const callee = node.callee;
            if (
              callee?.type !== "Identifier" ||
              (node.arguments?.length ?? 0) !== 0 ||
              node.optional === true
            ) return;
            const calleeName: string = callee.name;

            let cursor: any = node.parent;
            while (cursor) {
              const isFn = cursor.type === "ArrowFunctionExpression" ||
                cursor.type === "FunctionExpression" ||
                cursor.type === "FunctionDeclaration";
              if (isFn) {
                if (paramRebindsName(cursor.params, calleeName)) {
                  const entry = shows.get(cursor);
                  if (
                    entry &&
                    entry.paramName === calleeName &&
                    !entry.bodyHasRebinding
                  ) {
                    entry.calls.push(node);
                  }
                  return;
                }
              }
              cursor = cursor.parent;
            }
          },

          "JSXElement:exit"(node: any) {
            const opening = node.openingElement;
            const name = opening?.name;
            if (name?.type !== "JSXIdentifier") return;
            if (!TARGET_TAGS.has(name.name)) return;

            let fnExpr: any | undefined;
            for (const child of node.children ?? []) {
              if (
                child.type === "JSXExpressionContainer" &&
                (child.expression?.type === "ArrowFunctionExpression" ||
                  child.expression?.type === "FunctionExpression")
              ) {
                fnExpr = child.expression;
                break;
              }
            }
            const entry = fnExpr ? shows.get(fnExpr) : undefined;
            if (!entry || entry.reported) return;
            entry.reported = true;

            const { openingName, paramName, calls, existingKeyedAttr } = entry;

            if (existingKeyedAttr) {
              context.report({ node: opening, message });
              return;
            }

            context.report({
              node: opening,
              message,
              fix(fixer) {
                const fixes: Deno.lint.Fix[] = [];
                fixes.push(
                  fixer.insertTextAfterRange(
                    openingName.range as [number, number],
                    " keyed",
                  ),
                );
                if (paramName && !entry.bodyHasRebinding) {
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
    ) return attr.value.expression;
  }
  return null;
}

// True if `callee` references one of the tracked solid-relay primitives,
// either as a bare identifier or via a namespace member access.
function isRelayPrimitiveCall(call: any): boolean {
  const callee = call.callee;
  if (!callee) return false;
  if (callee.type === "Identifier") {
    return RELAY_PRIMITIVES.has(callee.name);
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    const prop = callee.property;
    return prop?.type === "Identifier" && RELAY_PRIMITIVES.has(prop.name);
  }
  return false;
}

// Walk a destructuring pattern and bind every identifier it introduces.
function bindIdentifiersAsRelay(
  pattern: any,
  bind: (name: string) => void,
): void {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      bind(pattern.name);
      return;
    case "AssignmentPattern":
      bindIdentifiersAsRelay(pattern.left, bind);
      return;
    case "RestElement":
      bindIdentifiersAsRelay(pattern.argument, bind);
      return;
    case "ArrayPattern":
      for (const e of pattern.elements ?? []) bindIdentifiersAsRelay(e, bind);
      return;
    case "ObjectPattern":
      for (const p of pattern.properties ?? []) {
        if (p.type === "RestElement") {
          bindIdentifiersAsRelay(p.argument, bind);
        } else if (p.type === "Property") {
          bindIdentifiersAsRelay(p.value, bind);
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
function detectRebinding(root: any, name: string): boolean {
  const FIELDS: Record<string, readonly string[]> = {
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
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression") &&
      node.id?.type === "Identifier" &&
      node.id.name === name
    ) return true;
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      paramRebindsName(node.params, name)
    ) return true;

    const fields = FIELDS[node.type];
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

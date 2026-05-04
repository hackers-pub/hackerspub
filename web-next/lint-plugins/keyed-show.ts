// deno-lint-ignore-file no-explicit-any
//
// Custom Deno lint plugin: enforce `<Show keyed>` and `<Match keyed>` whenever
// the children is a function with arity ≥ 1.
//
// Why: Solid's non-keyed `<Show when={x}>{(value) => ...}` passes a guarded
// accessor to the children. The accessor throws "Stale read from <Show>" if
// it's invoked while the condition is falsy. solid-relay publishes fragment
// snapshots inside `batch()`, so any descendant reactive computation that
// shares dependencies with the gated field can race with the Show's own
// re-evaluation and trip that throw. With `keyed`, the children receives the
// value directly — no guarded accessor, no stale-read race. Relay's
// `reconcile({ key: "__id", merge: true })` keeps record identity stable, so
// `keyed` only re-mounts on actual record changes.
//
// The autofix:
//   1. Inserts a `keyed` attribute on the opening element.
//   2. Replaces bare `param()` call expressions inside the children function
//      body with `param`, so the body type-checks under the value form.
//
// The body rewrite is only applied when it's provably safe — i.e., the body
// contains no lexical re-binding of the param name (no `const`/`let`/`var`,
// no `catch (param)`, no nested function param, no function declaration). If
// any rebind exists we still flag and add `keyed`, but we leave the body
// alone for manual cleanup.

const TARGET_TAGS = new Set(["Show", "Match"]);

type ShowEntry = {
  openingName: any;
  paramName: string | null;
  fnExpr: any;
  bodyHasRebinding: boolean;
  // Existing `keyed={...}` attribute with a non-statically-true value, if
  // any. When set, we report without autofix because we don't know whether
  // the user wanted truthy or falsy and don't want to silently change it.
  existingKeyedAttr: any | null;
  calls: any[];
  reported: boolean;
};

const plugin: Deno.lint.Plugin = {
  name: "hackerspub-solid",
  rules: {
    "show-keyed-on-fn-child": {
      create(context) {
        const shows = new Map<any, ShowEntry>();

        const message =
          "Use <Show keyed>/<Match keyed> when the children is a function " +
          "to avoid Solid's stale-accessor race when the gated value flips " +
          "to null inside a batch() update (e.g., a solid-relay publish). " +
          "With keyed, the children receives the value directly; reconcile " +
          "keeps the record's identity stable, so keyed only re-mounts on " +
          "actual record changes.";

        return {
          JSXElement(node: any) {
            const opening = node.openingElement;
            const name = opening?.name;
            if (name?.type !== "JSXIdentifier") return;
            if (!TARGET_TAGS.has(name.name)) return;

            // Skip when an explicitly-truthy `keyed` is already present.
            // Treat `keyed={false}`, `keyed={someVar}`, etc. as still
            // unsafe — only the shorthand `keyed` and `keyed={true}` count.
            // Track a non-static-true `keyed` attribute so we don't try to
            // autofix it (would produce `<Show keyed keyed={false}>`).
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

            // Conservatively detect any same-name rebinding inside the body
            // (variable declarators, catch params, nested function params,
            // function declaration ids). If found we skip the body rewrite.
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

            // Walk up function scopes from innermost to outermost; the first
            // scope that binds `calleeName` owns this call. We only collect
            // when that scope is one of our tracked Show callbacks.
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

            // If there's an explicit `keyed={non-static-true}` attribute, we
            // don't know what the user wants — report without autofix.
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

// True if attribute is `keyed` (shorthand) or `keyed={true}`.
function isStaticTrueAttribute(attr: any): boolean {
  if (attr.value == null) return true;
  const v = attr.value;
  if (v.type === "JSXExpressionContainer") {
    const expr = v.expression;
    if (
      expr?.type === "Literal" && expr.value === true
    ) return true;
    if (
      expr?.type === "BooleanLiteral" && expr.value === true
    ) return true;
  }
  return false;
}

function paramRebindsName(params: any[] | undefined, name: string): boolean {
  for (const p of params ?? []) {
    if (paramRebinds(p, name)) return true;
  }
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

// Walk the body subtree and report whether any node introduces a binding
// for `name`. We don't try to model precise lexical scopes — this is a
// conservative check meant to suppress the body rewrite whenever there is
// any same-name binder anywhere in the subtree. Known binder sites:
//   - VariableDeclarator with `id.name === name` (or destructuring binding).
//   - CatchClause with `param.name === name` (or destructuring).
//   - Nested function params with `name`.
//   - FunctionDeclaration / FunctionExpression / ClassDeclaration whose
//     own identifier is `name`.
//   - Import declarations (rare inside function bodies, but harmless).
function detectRebinding(root: any, name: string): boolean {
  // Known fields per node type that we should descend into. The AST objects
  // are lazy proxies in Deno's lint runtime, so we can't enumerate keys via
  // Object.keys — every type-of-interest must list its child fields here.
  const FIELDS: Record<string, readonly string[]> = {
    // Statements
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
    // Functions / classes
    FunctionDeclaration: ["id", "params", "body"],
    FunctionExpression: ["id", "params", "body"],
    ArrowFunctionExpression: ["params", "body"],
    ClassDeclaration: ["id", "superClass", "body"],
    ClassExpression: ["id", "superClass", "body"],
    ClassBody: ["body"],
    MethodDefinition: ["key", "value"],
    PropertyDefinition: ["key", "value"],
    StaticBlock: ["body"],
    // Expressions
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
    // JSX
    JSXElement: ["openingElement", "closingElement", "children"],
    JSXFragment: ["openingFragment", "closingFragment", "children"],
    JSXOpeningElement: ["name", "attributes"],
    JSXClosingElement: ["name"],
    JSXAttribute: ["name", "value"],
    JSXSpreadAttribute: ["argument"],
    JSXExpressionContainer: ["expression"],
    JSXSpreadChild: ["expression"],
    // Patterns (within bindings)
    ArrayPattern: ["elements"],
    ObjectPattern: ["properties"],
    RestElement: ["argument"],
    AssignmentPattern: ["left", "right"],
    // TS-specific (defensive)
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

    // Binder sites:
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

// Identifier or destructuring pattern binding `name`?
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

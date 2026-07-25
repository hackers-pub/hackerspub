// Custom oxlint plugin: keep Deno runtime APIs out of the tree.
//
// The application runs on Node.js only.  A `Deno.*` reference compiles and
// lints fine as long as nobody executes that branch, so it can sit unnoticed
// until the code path runs in production and throws `Deno is not defined`.
// This rule fails the build instead.
//
// Whether an identifier really means the global is decided by the scope chain
// rather than by pattern matching, so a local binding named `Deno` -- a
// parameter, a destructured property, an import -- is left alone, and so is a
// locally shadowed `globalThis`.  The string `"Deno"` is untouched, so prose in
// comments, test names, and log messages is unaffected.

const GLOBAL_NAME = "Deno";
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

/** oxlint passes plain ESTree nodes with no published type definitions. */
type Node = any;

// oxlint materializes AST nodes on demand, so reading the same node twice can
// yield two different objects.  Compare source positions instead of identity.
function isSameNode(a: Node, b: Node): boolean {
  return (
    a != null &&
    b != null &&
    a.range?.[0] === b.range?.[0] &&
    a.range?.[1] === b.range?.[1]
  );
}

/**
 * Strips the wrappers that do not change what an expression evaluates to, so
 * `(globalThis as any).Deno` is recognized as `globalThis.Deno`.
 */
function unwrap(node: Node): Node {
  let current = node;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSTypeAssertion" ||
    current?.type === "TSInstantiationExpression" ||
    current?.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether the identifier names something (a property, a label, an imported
 * binding) rather than referring to a variable.
 */
function isNonReference(node: Node): boolean {
  const parent = node.parent;
  switch (parent?.type) {
    case "MemberExpression":
      return !parent.computed && isSameNode(parent.property, node);
    case "Property":
      // `{ Deno }` gives its key and value the same range, so the range check
      // below cannot tell them apart.  Shorthand always reads the variable --
      // in an object pattern it binds it instead, which scope resolution
      // already accounts for.
      if (parent.shorthand) return false;
      return !parent.computed && isSameNode(parent.key, node);
    case "PropertyDefinition":
    case "MethodDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
    case "TSEnumMember":
      return !parent.computed && isSameNode(parent.key, node);
    case "TSQualifiedName":
      return isSameNode(parent.right, node);
    case "ImportSpecifier":
      return isSameNode(parent.imported, node);
    case "ExportSpecifier":
      return true;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return true;
    default:
      return false;
  }
}

/** Renders `Deno.env.get` from the reference so the message names the API. */
function describe(node: Node, prefix: string): string {
  let reference = prefix;
  let current = node;
  for (;;) {
    const parent = current.parent;
    const property =
      parent?.type === "MemberExpression" &&
      !parent.computed &&
      isSameNode(parent.object, current)
        ? parent.property
        : parent?.type === "TSQualifiedName" && isSameNode(parent.left, current)
          ? parent.right
          : undefined;
    if (property?.type !== "Identifier") return reference;
    reference += `.${property.name}`;
    current = parent;
  }
}

function message(reference: string): string {
  return (
    `Do not use the Deno runtime API \`${reference}\`. This application runs ` +
    "on Node.js only; use the `node:` built-ins, `process.env` (or " +
    "`getProcessEnvironment()` from `@hackerspub/runtime/config`), or " +
    "`process.exitCode` instead."
  );
}

const plugin = {
  meta: {
    name: "hackerspub-runtime",
  },
  name: "hackerspub-runtime",
  rules: {
    "no-deno-globals": {
      create(context: Node) {
        // `isGlobalReference()` only recognizes *declared* globals, and `Deno`
        // is declared nowhere now that the Deno type libraries are gone, so
        // resolve the name through the scope chain instead: a name no
        // enclosing scope binds can only be the global.
        const isGlobal = (node: Node, name: string): boolean => {
          for (
            let scope = context.sourceCode.getScope(node);
            scope != null;
            scope = scope.upper
          ) {
            const variable = scope.set?.get(name);
            if (variable == null) continue;
            // Something declared the name, so it is only the runtime global if
            // the declaration is implicit.  Checking the scope kind instead
            // would misread a script's top-level `const Deno = shim`, which
            // lands in the global scope but is still a real binding.
            return (variable.defs?.length ?? 0) < 1;
          }
          return true;
        };

        // A shorthand property visits the same identifier twice, once as the
        // key and once as the value, so reporting has to be idempotent per
        // source position.
        const reported = new Set<string>();
        const report = (node: Node, prefix: string) => {
          const position = `${node.range?.[0]}:${node.range?.[1]}`;
          if (reported.has(position)) return;
          reported.add(position);
          context.report({ node, message: message(describe(node, prefix)) });
        };

        return {
          // `globalThis.Deno`, the indirect route to the same object.  The
          // object has to be the real global, or this is somebody's own
          // `globalThis` stand-in and `Deno` is just one of its properties.
          MemberExpression(node: Node) {
            if (node.computed) return;
            if (node.property?.type !== "Identifier") return;
            if (node.property.name !== GLOBAL_NAME) return;
            const object = unwrap(node.object);
            if (object?.type !== "Identifier") return;
            if (!GLOBAL_OBJECTS.has(object.name)) return;
            if (!isGlobal(object, object.name)) return;
            report(node, `${object.name}.${GLOBAL_NAME}`);
          },

          // Every other position: a value reference, the left side of a
          // `TSQualifiedName`, `typeof Deno`.
          Identifier(node: Node) {
            if (node.name !== GLOBAL_NAME) return;
            if (isNonReference(node)) return;
            if (!isGlobal(node, GLOBAL_NAME)) return;
            report(node, GLOBAL_NAME);
          },
        };
      },
    },
  },
};

export default plugin;

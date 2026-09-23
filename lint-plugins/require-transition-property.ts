// Custom oxlint plugin: an element that sets transition timing must also say
// which properties transition.
//
// Tailwind's `duration-*` and `ease-*` utilities are usually reached for to
// tune an `animate-*` entrance, because tw-animate-css feeds the animation
// through `--tw-duration` / `--tw-ease`.  But those utilities also set the
// plain CSS `transition-duration` and `transition-timing-function`, and
// `transition-property` keeps its CSS initial value of `all` unless a
// `transition-*` utility overrides it.  So every property that later changes
// on that element -- a hover background-color, a JS-assigned `left`/`top` --
// silently transitions with the animation's duration and easing.
//
// That is not merely redundant motion.  Entrance animations often use an
// overshooting bezier (`cubic-bezier(0.34,1.56,0.64,1)` and friends), and
// interpolation past the target extrapolates before clamping: a near-white
// `accent` background overshoots to pure white, so a hover circle appears,
// dissolves into a light-theme background, and comes back -- read by users as
// a flicker.  A JS-positioned popover animates in from (0,0) instead of
// appearing where it was placed.  Both cost real debugging time because the
// class that causes them looks like it only concerns the entrance.
//
// The fix is always to be explicit: `transition-none` when the timing is only
// meant for the `animate-*` entrance, or the property list that should
// genuinely transition (`transition-colors`, `transition-transform`, ...).
//
// Scope and deliberate blind spots:
//
//   - Only JSX elements are checked, and `class` / `className` / `classList`
//     are read together.  A `transition-*` satisfies timing utilities only in
//     the same or a broader variant scope: `transition-none` covers
//     `motion-safe:duration-300`, but `motion-reduce:transition-none` does not.
//   - An element whose classes cannot be read statically (a variable, a call,
//     a template literal with interpolation, a spread attribute) is skipped
//     entirely rather than guessed at: the missing piece could be the very
//     `transition-*` this rule asks for.
//   - Class strings outside JSX (`cva()` bases and variants, exported class
//     constants) are not checked.  They are composed at runtime from several
//     fragments, so a fragment holding `duration-*` without `transition-*` is
//     not by itself a defect.
//
// `transition-discrete` and `transition-normal` are excluded: they set
// `transition-behavior`, not `transition-property`.

/** oxlint passes plain ESTree nodes with no published type definitions. */
type Node = any;

const CLASS_ATTRIBUTES = new Set(["class", "className"]);
const TRANSITION_BEHAVIOR = new Set([
  "transition-discrete",
  "transition-normal",
]);

/** Reads a string out of the several literal node shapes oxlint emits. */
function stringValue(node: Node): string | null {
  if (node == null) return null;
  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

/**
 * Drops the variant prefixes from a utility, so `motion-safe:duration-300`
 * becomes `duration-300`.  Only colons at bracket depth zero separate
 * variants; the ones inside `ease-[cubic-bezier(...)]` or `[&:hover]:` belong
 * to the value.
 */
function parseUtility(token: string): {
  readonly base: string;
  readonly variants: readonly string[];
} {
  let depth = 0;
  let segmentStart = 0;
  const variants: string[] = [];
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(token.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  return { base: token.slice(segmentStart), variants };
}

/** `duration-*` and `ease-*` both set a `transition-*` timing longhand. */
function setsTiming(base: string): boolean {
  return base.startsWith("duration-") || base.startsWith("ease-");
}

function setsTransitionProperty(base: string): boolean {
  if (base === "transition") return true;
  if (!base.startsWith("transition-")) return false;
  return !TRANSITION_BEHAVIOR.has(base);
}

interface ScopedUtility {
  readonly attribute: Node;
  readonly variants: readonly string[];
}

interface Scan {
  /** Timing utilities and their variant constraints. */
  timings: ScopedUtility[];
  /** Variant constraints for every explicit transition property utility. */
  transitions: Array<readonly string[]>;
  /** Some class source could not be read, so the scan is inconclusive. */
  opaque: boolean;
}

function scanTokens(source: string, attribute: Node, scan: Scan): void {
  for (const token of source.split(/\s+/)) {
    if (token === "") continue;
    const { base, variants } = parseUtility(token);
    if (setsTransitionProperty(base)) scan.transitions.push(variants);
    else if (setsTiming(base)) scan.timings.push({ attribute, variants });
  }
}

/**
 * Variant prefixes act as constraints.  A transition property covers a
 * timing utility when every one of its constraints is also present on that
 * timing utility.  The empty scope therefore covers all variants, while
 * `dark:transition-colors` covers `dark:hover:duration-150` but not the
 * unrelated `motion-safe:duration-150`.
 */
function transitionCoversTiming(
  transitionVariants: readonly string[],
  timingVariants: readonly string[],
): boolean {
  return transitionVariants.every((variant) =>
    timingVariants.includes(variant),
  );
}

function scanClassAttribute(attribute: Node, scan: Scan): void {
  const literal = stringValue(attribute.value);
  if (literal != null) {
    scanTokens(literal, attribute, scan);
    return;
  }
  if (attribute.value?.type !== "JSXExpressionContainer") {
    scan.opaque = true;
    return;
  }
  const expression = attribute.value.expression;
  const inner = stringValue(expression);
  if (inner != null) {
    scanTokens(inner, attribute, scan);
    return;
  }
  if (expression?.type !== "TemplateLiteral") {
    scan.opaque = true;
    return;
  }
  // The static parts still count, but an interpolation may contribute the
  // `transition-*` that would clear the report.
  for (const quasi of expression.quasis ?? []) {
    const text = quasi.value?.cooked ?? quasi.value?.raw;
    if (typeof text === "string") scanTokens(text, attribute, scan);
  }
  if ((expression.expressions?.length ?? 0) > 0) scan.opaque = true;
}

function scanClassListAttribute(attribute: Node, scan: Scan): void {
  if (attribute.value?.type !== "JSXExpressionContainer") {
    scan.opaque = true;
    return;
  }
  const expression = attribute.value.expression;
  if (expression?.type !== "ObjectExpression") {
    scan.opaque = true;
    return;
  }
  for (const property of expression.properties ?? []) {
    if (property.type !== "Property" && property.type !== "ObjectProperty") {
      scan.opaque = true;
      continue;
    }
    if (property.computed) {
      scan.opaque = true;
      continue;
    }
    const key =
      stringValue(property.key) ??
      (property.key?.type === "Identifier" ? property.key.name : null);
    if (key == null) scan.opaque = true;
    else scanTokens(key, attribute, scan);
  }
}

const MESSAGE =
  "This element sets transition timing (`duration-*` / `ease-*`) without a " +
  "`transition-*` utility, so `transition-property` keeps its initial value " +
  "of `all` and every property change on the element -- hover colors, " +
  "JS-assigned positions -- transitions with that duration and easing. Add " +
  "`transition-none` when the timing is only meant for an `animate-*` " +
  "entrance, or name the properties that should transition (e.g. " +
  "`transition-colors`).";

const plugin = {
  meta: {
    name: "hackerspub-tailwind",
  },
  name: "hackerspub-tailwind",
  rules: {
    "require-transition-property": {
      create(context: Node) {
        return {
          JSXOpeningElement(node: Node) {
            const scan: Scan = {
              timings: [],
              transitions: [],
              opaque: false,
            };
            for (const attribute of node.attributes ?? []) {
              if (attribute.type === "JSXSpreadAttribute") {
                // `{...props}` can carry a class this rule cannot see.
                scan.opaque = true;
                continue;
              }
              if (attribute.type !== "JSXAttribute") continue;
              if (attribute.name?.type !== "JSXIdentifier") continue;
              const name = attribute.name.name;
              if (CLASS_ATTRIBUTES.has(name)) {
                scanClassAttribute(attribute, scan);
              } else if (name === "classList") {
                scanClassListAttribute(attribute, scan);
              }
            }
            if (scan.opaque) return;
            const uncovered = scan.timings.find(
              (timing) =>
                !scan.transitions.some((transition) =>
                  transitionCoversTiming(transition, timing.variants),
                ),
            );
            if (uncovered == null) return;
            context.report({ node: uncovered.attribute, message: MESSAGE });
          },
        };
      },
    },
  },
};

export default plugin;

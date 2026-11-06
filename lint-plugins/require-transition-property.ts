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
// The fix depends on what the timing was for.  For an `animate-*` animation,
// tw-animate-css's `animation-duration-*` sets only `animation-duration` and
// leaves transitions alone.  Animations with a fixed duration (`animate-spin`,
// `animate-caret-blink`, ...) never read `--tw-duration`, so a `duration-*`
// beside them does nothing but cause the problem above and should be dropped.
// When something should genuinely transition, name it (`transition-colors`,
// `transition-transform`, ...).  tw-animate-css has no `animation-ease-*`, so a
// custom `ease-*` for an animation is the one case that needs
// `transition-none`.
//
// Scope and deliberate blind spots:
//
//   - Only JSX elements are checked, and `class` / `className` / `classList`
//     are read together.  A `transition-*` satisfies timing utilities only in
//     the same or a broader variant scope: `transition-none` covers
//     `motion-safe:duration-300`, but `motion-reduce:transition-none` does not.
//     Target-changing variants (children, pseudo-elements, arbitrary selectors)
//     must have matching ordered prefixes on both utilities.
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
  // Tailwind v4 uses a trailing `!`; the leading form remains supported.
  const base = token.slice(segmentStart).replace(/^!|!$/g, "");
  return { base, variants };
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

/** Variants that select another element rather than constrain the current one. */
const TARGET_VARIANTS = new Set([
  "*",
  "**",
  "before",
  "after",
  "first-letter",
  "first-line",
  "marker",
  "selection",
  "file",
  "placeholder",
  "backdrop",
  "details-content",
]);

function changesTarget(variant: string): boolean {
  if (TARGET_VARIANTS.has(variant)) return true;
  if (!variant.startsWith("[") || variant.startsWith("[@")) return false;
  // Simple self selectors only add conditions. For other arbitrary selectors,
  // require an exact prefix match rather than guessing at their target.
  return !/^\[&(?::[\w-]+|\[[^\]]*\])*\]$/.test(variant);
}

/**
 * Match the ordered prefix through the last target change exactly. Conditions
 * after that prefix may be broader on the transition utility. This prevents a
 * property on the parent from covering timing on a child or pseudo-element,
 * and keeps `hover:before` distinct from `before:hover`.
 */
function transitionCoversTiming(
  transitionVariants: readonly string[],
  timingVariants: readonly string[],
): boolean {
  const transitionTarget = transitionVariants.findLastIndex(changesTarget);
  const timingTarget = timingVariants.findLastIndex(changesTarget);
  if (transitionTarget !== timingTarget) return false;
  for (let index = 0; index <= transitionTarget; index++) {
    if (transitionVariants[index] !== timingVariants[index]) return false;
  }
  return transitionVariants
    .slice(transitionTarget + 1)
    .every((variant) =>
      timingVariants.slice(timingTarget + 1).includes(variant),
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

/** Returns null when a classList value's truthiness is not statically known. */
function staticTruthiness(node: Node): boolean | null {
  if (node == null) return null;
  if (node.type === "NullLiteral") return false;
  if (
    [
      "Literal",
      "StringLiteral",
      "NumericLiteral",
      "BooleanLiteral",
      "BigIntLiteral",
    ].includes(node.type)
  ) {
    // ESTree bigint literals expose a bigint value; Babel exposes a string.
    if (node.type === "BigIntLiteral") return BigInt(node.value) !== 0n;
    return Boolean(node.value);
  }
  if (node.type === "UnaryExpression") {
    if (node.operator === "void") return false;
    if (node.operator === "!") {
      const argument = staticTruthiness(node.argument);
      return argument == null ? null : !argument;
    }
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return Boolean(node.quasis[0]?.value?.cooked);
  }
  return null;
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
    const truthiness = staticTruthiness(property.value);
    if (truthiness === false) continue;
    if (
      property.computed ||
      property.method ||
      (property.kind != null && property.kind !== "init")
    ) {
      scan.opaque = true;
      continue;
    }
    const key =
      stringValue(property.key) ??
      (property.key?.type === "Identifier" ? property.key.name : null);
    if (key == null) {
      scan.opaque = true;
      continue;
    }
    const entry: Scan = { timings: [], transitions: [], opaque: false };
    scanTokens(key, attribute, entry);
    scan.timings.push(...entry.timings);
    if (truthiness == null && entry.transitions.length > 0) {
      // A dynamic property may cover timing, but is not known to be applied.
      scan.opaque = true;
    } else {
      scan.transitions.push(...entry.transitions);
    }
  }
}

const MESSAGE =
  "This element sets transition timing (`duration-*` / `ease-*`) without a " +
  "`transition-*` utility, so `transition-property` keeps its initial value " +
  "of `all` and every property change on the element -- hover colors, " +
  "JS-assigned positions, theme color switches -- transitions with that " +
  "duration and easing. If the timing is for an `animate-*` animation, use " +
  "`animation-duration-*` instead, which leaves transitions alone; animations " +
  "with a fixed duration such as `animate-spin` or `animate-caret-blink` " +
  "ignore `duration-*` entirely, so just drop it. If something should really " +
  "transition, name the properties (e.g. `transition-colors`). Keep a custom " +
  "`ease-*` for an animation only together with `transition-none`.";

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

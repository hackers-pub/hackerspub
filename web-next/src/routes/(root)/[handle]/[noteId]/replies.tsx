// The `/replies` sub-route is the canonical destination for the
// engagement bar's reply control.  It is an intentional alias of the
// bare permalink at `./index.tsx`, which renders the full thread view:
// the ancestor chain up to the thread root, the focused post with an
// inline composer, and the nested reply tree.
export { default, route } from "./index.tsx";

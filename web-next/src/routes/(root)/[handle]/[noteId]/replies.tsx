// The `/replies` sub-route is the canonical destination for the
// engagement bar's reply control.  For now it re-uses the bare
// permalink renderer at `./index.tsx`, which already shows the
// immediate parent, the focused post, an inline composer, and a flat
// paginated list of direct replies.  A follow-up unit will extend the
// thread view here with a deeper ancestor chain and recursive
// descendant expansion, at which point the two routes will diverge in
// content as the user requested.
export { default, route } from "./index.tsx";

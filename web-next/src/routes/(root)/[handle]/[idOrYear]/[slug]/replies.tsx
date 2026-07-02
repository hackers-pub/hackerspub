// The `/replies` sub-route is the canonical destination for the
// engagement bar's reply control on articles.  It is an intentional
// alias of the bare permalink at `./index.tsx`, which embeds the
// nested reply tree (the same renderer note permalinks use) under the
// article body.
export { default, route } from "./index.tsx";

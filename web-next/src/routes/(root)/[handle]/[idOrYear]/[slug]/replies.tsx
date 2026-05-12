// The `/replies` sub-route is the canonical destination for the
// engagement bar's reply control on articles.  Articles already
// embed the conversation under the body via `Slug_replies` on the
// bare permalink, so re-export that view for now.  A future
// iteration will swap this for a dedicated thread renderer that
// matches what the note `/replies` route eventually grows into.
export { default, route } from "./index.tsx";

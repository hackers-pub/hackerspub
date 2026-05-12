// Transitional shim: PostControls used to be a self-contained engagement
// bar; it now re-exports `PostEngagementBar`, the unified replacement that
// matches DESIGN.md (inline Heroicons outline) and exposes the new viewer
// action policy fields.  Direct imports will migrate to
// `./PostEngagementBar.tsx` in the next commit.
export {
  PostEngagementBar as PostControls,
  type PostEngagementBarProps as PostControlsProps,
} from "./PostEngagementBar.tsx";

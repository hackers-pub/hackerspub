import { installHeaderAnchorLinks } from "@hackerspub/models/header-anchor";
import { useEffect } from "preact/hooks";

export function HeaderAnchorLinks() {
  useEffect(() => installHeaderAnchorLinks(document), []);
  return null;
}

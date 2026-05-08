import { useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { splitProps, startTransition } from "solid-js";

export interface InternalLinkProps
  extends Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "target"> {
  internalHref: string | URL;
}

export function InternalLink(props: InternalLinkProps) {
  const [internalProps, restProps] = splitProps(props, [
    "internalHref",
    "children",
  ]);
  const navigate = useNavigate();
  function onClick(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      // let the browser handle the click for new tab / window
      const anchor = event.currentTarget as HTMLAnchorElement;
      anchor.href = internalProps.internalHref.toString();
      setTimeout(() => {
        anchor.href = props.href ?? "";
      }, 1);
      return;
    }
    event.preventDefault();
    void startTransition(() => navigate(internalProps.internalHref.toString()));
  }
  return <a {...restProps} on:click={onClick}>{internalProps.children}</a>;
}

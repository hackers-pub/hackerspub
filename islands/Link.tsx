import type { JSX } from "preact";

export type LinkProps = JSX.AnchorHTMLAttributes<HTMLAnchorElement> & {
  internalHref?: string | URL;
};

export function Link(props: LinkProps) {
  const propsWithoutChildren: LinkProps = { ...props };
  delete propsWithoutChildren.children;
  delete propsWithoutChildren.internalHref;
  function onClick(
    this: HTMLAnchorElement,
    event: JSX.TargetedMouseEvent<HTMLAnchorElement>,
  ) {
    props.onClick?.apply(this, [event]);
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (props.internalHref == null) return;
    event.preventDefault();
    location.href = props.internalHref.toString();
  }
  return <a {...propsWithoutChildren} onClick={onClick}>{props.children}</a>;
}

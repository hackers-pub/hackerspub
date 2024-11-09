import type { ComponentChildren } from "preact";

export interface PageTitleProps {
  children?: ComponentChildren;
}

export function PageTitle(props: PageTitleProps) {
  return <h1 class="text-xl font-bold mb-5">{props.children}</h1>;
}

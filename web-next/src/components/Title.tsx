import { Title as MetaTitle } from "@solidjs/meta";
import { JSX } from "solid-js";

export interface TitleProps extends JSX.HTMLAttributes<HTMLTitleElement> {
}

export function Title(props: TitleProps) {
  return (
    <MetaTitle {...props}>
      {import.meta.env.DEV ? "DEV: " : ""}
      {props.children}
    </MetaTitle>
  );
}

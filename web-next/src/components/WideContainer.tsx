import type { ComponentProps } from "solid-js";
import { cn } from "~/lib/utils.ts";

export function WideContainer(props: ComponentProps<"div">) {
  return (
    <div {...props} class={cn("max-w-7xl mx-auto", props.class)}>
      {props.children}
    </div>
  );
}

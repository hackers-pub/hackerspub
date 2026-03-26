import type { ComponentProps } from "solid-js";
import { cn } from "~/lib/utils.ts";

export function NarrowContainer(props: ComponentProps<"div">) {
  return (
    <div {...props} class={cn("max-w-160 mx-auto", props.class)}>
      {props.children}
    </div>
  );
}

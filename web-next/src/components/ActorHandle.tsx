import { type ComponentProps, splitProps } from "solid-js";
import { cn } from "~/lib/utils.ts";

export interface ActorHandleProps extends Omit<
  ComponentProps<"span">,
  "children"
> {
  readonly handle: string;
}

/** Displays a canonical fediverse handle without altering its copyable text. */
export function ActorHandle(props: ActorHandleProps) {
  const [local, others] = splitProps(props, ["handle", "class", "title"]);
  return (
    <span
      {...others}
      class={cn("select-all", local.class)}
      title={local.title ?? local.handle}
    >
      {local.handle}
    </span>
  );
}

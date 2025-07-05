import { ComponentProps } from "solid-js";
import { Breadcrumb, BreadcrumbList } from "./ui/breadcrumb.tsx";
import { Separator } from "./ui/separator.tsx";
import { SidebarTrigger } from "./ui/sidebar.tsx";

export function TopBreadcrumb(props: ComponentProps<"ol">) {
  return (
    <header class="flex items-center gap-2 w-full h-16 border-b px-4 shrink-0">
      <SidebarTrigger class="-ml-1 cursor-pointer" />
      <Separator orientation="vertical" class="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {props.children}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}

import { ComponentProps } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
} from "./ui/breadcrumb.tsx";
import { Separator } from "./ui/separator.tsx";
import { SidebarTrigger } from "./ui/sidebar.tsx";

export function TopBreadcrumb(props: ComponentProps<"ol">) {
  const { t } = useLingui();
  return (
    <header class="flex items-center gap-2 w-full h-16 border-b px-4 shrink-0">
      <SidebarTrigger class="-ml-1 cursor-pointer" />
      <Separator orientation="vertical" class="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">{t`Home`}</BreadcrumbLink>
          </BreadcrumbItem>
          {props.children}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}

import type { RouteSectionProps } from "@solidjs/router";
import { AppSidebar } from "../components/AppSidebar.tsx";
import { SidebarProvider } from "../components/ui/sidebar.tsx";

export default function RootLayout(props: RouteSectionProps) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <main class="w-full">
        {props.children}
      </main>
    </SidebarProvider>
  );
}

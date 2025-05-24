import { createAsync, query, revalidate } from "@solidjs/router";
import { Button } from "~/components/ui/button.tsx";

const loadDenoBuild = query(async () => {
  "use server";

  return Deno.build.target;
}, "deno-build");

const loadOsUptime = query(async () => {
  "use server";

  return Deno.osUptime();
}, "os-uptime");

export default function Home() {
  const denoBuild = createAsync(() => loadDenoBuild());
  const osUptime = createAsync(() => loadOsUptime());

  return (
    <main>
      <h1>Hello world from Deno built for {denoBuild()}!</h1>
      <p>OS uptime: {osUptime()}</p>
      <Button onClick={() => revalidate("os-uptime")}>
        refresh uptime
      </Button>
    </main>
  );
}

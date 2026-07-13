#!/usr/bin/env -S deno run -A --watch=static/,routes/
import { tailwind } from "@fresh/plugin-tailwind";

import { Builder } from "@fresh/core/dev";
import { app, closeWebResources, runWebServer } from "./main.ts";

const builder = new Builder();
tailwind(builder, app, {});
if (Deno.args.includes("build")) {
  try {
    await builder.build(app);
  } finally {
    await closeWebResources();
  }
} else {
  await runWebServer((signal) => builder.listen(app, { signal }));
}

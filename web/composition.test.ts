import { assert, assertStringIncludes } from "@std/assert";

Deno.test("legacy web owns the federation queue lifecycle", async () => {
  const source = await Deno.readTextFile(new URL("main.ts", import.meta.url));

  assertStringIncludes(source, "manuallyStartQueue: true");
  assertStringIncludes(source, "await runWithFederationQueue(");
  assertStringIncludes(source, "(signal) => app.listen({ signal })");
  assertStringIncludes(source, "Deno.addSignalListener(signalName, listener)");
  assertStringIncludes(source, "removeSignalListeners()");
  assertStringIncludes(source, "{ signal: controller.signal }");
  assert(
    source.indexOf("await runWithFederationQueue(") <
      source.indexOf("await resources.close()"),
    "the federation queue must stop before its resources close",
  );
});

Deno.test("Fresh development starts the federation queue but static builds do not", async () => {
  const source = await Deno.readTextFile(new URL("dev.ts", import.meta.url));
  const buildBranch = source.slice(
    source.indexOf('if (Deno.args.includes("build"))'),
    source.indexOf("} else {"),
  );
  const listenBranch = source.slice(source.indexOf("} else {"));

  assertStringIncludes(buildBranch, "await closeWebResources()");
  assert(
    !buildBranch.includes("runWebServer"),
    "static builds must not start the federation queue",
  );
  assertStringIncludes(
    listenBranch,
    "await runWebServer((signal) => builder.listen(app, { signal }))",
  );
});

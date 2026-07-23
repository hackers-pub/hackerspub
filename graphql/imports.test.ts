import { assertEquals } from "@std/assert";

Deno.test("resource modules can be imported without server configuration", async () => {
  const modules = await Promise.all([
    import("./ai.ts"),
    import("./db.ts"),
    import("./drive.ts"),
    import("./email.ts"),
    import("./federation.ts"),
    import("./kv.ts"),
  ]);

  assertEquals(modules.length, 6);
});

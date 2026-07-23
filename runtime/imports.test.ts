import { assertEquals } from "@std/assert";

Deno.test("resource modules can be imported without server configuration", async () => {
  const modules = await Promise.all([
    import("../graphql/ai.ts"),
    import("../graphql/db.ts"),
    import("../graphql/drive.ts"),
    import("../graphql/email.ts"),
    import("../graphql/federation.ts"),
    import("../graphql/kv.ts"),
  ]);

  assertEquals(modules.length, 6);
});

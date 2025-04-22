import { assertEquals } from "@std/assert/equals";
import { compactUrl } from "./url.ts";

Deno.test("compactUrl()", () => {
  assertEquals(
    compactUrl("https://example.com/"),
    "example.com",
  );
  assertEquals(
    compactUrl("https://example.com/test/"),
    "example.com/test",
  );
  assertEquals(
    compactUrl("https://example.com/test/?"),
    "example.com/test",
  );
  assertEquals(
    compactUrl("https://example.com/test/?#"),
    "example.com/test",
  );
  assertEquals(
    compactUrl("https://example.com/test/?#asdf"),
    "example.com/test/#asdf",
  );
});

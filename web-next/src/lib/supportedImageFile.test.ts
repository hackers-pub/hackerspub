import { assertEquals } from "@std/assert";
import {
  getSupportedImageContentType,
  hasSupportedImageContentType,
  isSupportedImageFile,
  supportedImageAccept,
  supportedImageMimeAccept,
} from "./supportedImageFile.ts";

Deno.test("getSupportedImageContentType accepts known image MIME types", () => {
  assertEquals(
    getSupportedImageContentType({ name: "photo.bin", type: "image/png" }),
    "image/png",
  );
  assertEquals(
    getSupportedImageContentType({ name: "photo.bin", type: "image/jpeg" }),
    "image/jpeg",
  );
});

Deno.test("getSupportedImageContentType falls back to extension for empty MIME", () => {
  assertEquals(
    getSupportedImageContentType({ name: "Pasted image.PNG", type: "" }),
    "image/png",
  );
  assertEquals(
    getSupportedImageContentType({
      name: "download.JPG",
      type: "application/octet-stream",
    }),
    "image/jpeg",
  );
});

Deno.test("getSupportedImageContentType rejects unsupported MIME and extensions", () => {
  assertEquals(
    getSupportedImageContentType({ name: "image.svg", type: "" }),
    null,
  );
  assertEquals(
    getSupportedImageContentType({ name: "image.png", type: "text/plain" }),
    null,
  );
});

Deno.test("isSupportedImageFile and accept list include extension fallback types", () => {
  assertEquals(isSupportedImageFile({ name: "image.webp", type: "" }), true);
  assertEquals(isSupportedImageFile({ name: "image.bmp", type: "" }), false);
  assertEquals(supportedImageAccept.includes(".jpg"), true);
  assertEquals(supportedImageAccept.includes("image/jpeg"), true);
  assertEquals(supportedImageMimeAccept.includes(".jpg"), false);
  assertEquals(supportedImageMimeAccept.includes("image/jpeg"), true);
});

Deno.test("hasSupportedImageContentType ignores extension fallback", () => {
  assertEquals(
    hasSupportedImageContentType({ type: "image/webp" }),
    true,
  );
  assertEquals(
    hasSupportedImageContentType({ type: "application/octet-stream" }),
    false,
  );
  assertEquals(hasSupportedImageContentType({ type: "" }), false);
});

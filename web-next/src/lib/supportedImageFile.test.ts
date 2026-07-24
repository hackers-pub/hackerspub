import { assertEquals } from "@std/assert";
import test from "node:test";
import {
  getSupportedImageContentType,
  hasSupportedImageContentType,
  isSupportedImageFile,
  supportedImageAccept,
  supportedImageMimeAccept,
} from "./supportedImageFile.ts";

test("getSupportedImageContentType accepts known image MIME types", () => {
  assertEquals(
    getSupportedImageContentType({ name: "photo.bin", type: "image/png" }),
    "image/png",
  );
  assertEquals(
    getSupportedImageContentType({ name: "photo.bin", type: "image/jpeg" }),
    "image/jpeg",
  );
});

test("getSupportedImageContentType falls back to extension for empty MIME", () => {
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

test("getSupportedImageContentType rejects unsupported MIME and extensions", () => {
  assertEquals(
    getSupportedImageContentType({ name: "image.svg", type: "" }),
    null,
  );
  assertEquals(
    getSupportedImageContentType({ name: "image.png", type: "text/plain" }),
    null,
  );
});

test("isSupportedImageFile and accept list include extension fallback types", () => {
  assertEquals(isSupportedImageFile({ name: "image.webp", type: "" }), true);
  assertEquals(isSupportedImageFile({ name: "image.bmp", type: "" }), false);
  assertEquals(supportedImageAccept.includes(".jpg"), true);
  assertEquals(supportedImageAccept.includes("image/jpeg"), true);
  assertEquals(supportedImageMimeAccept.includes(".jpg"), false);
  assertEquals(supportedImageMimeAccept.includes("image/jpeg"), true);
});

test("hasSupportedImageContentType ignores extension fallback", () => {
  assertEquals(hasSupportedImageContentType({ type: "image/webp" }), true);
  assertEquals(
    hasSupportedImageContentType({ type: "application/octet-stream" }),
    false,
  );
  assertEquals(hasSupportedImageContentType({ type: "" }), false);
});

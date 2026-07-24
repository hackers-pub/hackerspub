import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeResponseToFile } from "./medium.ts";

test("writeResponseToFile streams the response body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-medium-"));
  const path = join(directory, "video");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed video"));
        controller.close();
      },
    }),
  );
  Object.defineProperty(response, "arrayBuffer", {
    value() {
      throw new Error("response body must not be buffered");
    },
  });

  try {
    await writeResponseToFile(response, path);
    assert.equal(await readFile(path, "utf8"), "streamed video");
  } finally {
    await rm(directory, { recursive: true });
  }
});

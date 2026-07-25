import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import test from "node:test";
import { createNonClosingWebWritable } from "./non-closing-writable.node.ts";

test("closing the Web proxy flushes without closing its target", async () => {
  const chunks: Buffer[] = [];
  const target = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const writer = createNonClosingWebWritable(target).getWriter();

  await writer.write(new TextEncoder().encode("before close"));
  await writer.close();

  assert.equal(Buffer.concat(chunks).toString(), "before close");
  assert.equal(target.writableEnded, false);
  target.write(" after close");
  assert.equal(Buffer.concat(chunks).toString(), "before close after close");
  target.end();
});

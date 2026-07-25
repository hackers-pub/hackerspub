import { Writable } from "node:stream";

/**
 * Adapt a Node writable to a Web writable without transferring ownership.
 *
 * Closing the returned stream flushes and closes only the proxy. The target
 * remains available to its owner, which is required for process stdio.
 */
export function createNonClosingWebWritable(
  target: Writable,
): WritableStream<Uint8Array> {
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      target.write(chunk, encoding, callback);
    },
  });
  return Writable.toWeb(proxy) as WritableStream<Uint8Array>;
}

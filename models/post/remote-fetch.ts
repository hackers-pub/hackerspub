import type { DocumentLoader } from "@fedify/fedify";

export const REMOTE_FETCH_TIMEOUT_MS = 10_000;
export const PERSIST_POST_OVERALL_BUDGET_MS = 90_000;

export function getRemoteFetchSignal(signal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS), signal].filter(
    (s): s is AbortSignal => s != null,
  );
  return AbortSignal.any(signals);
}

export function withDocumentLoaderTimeout(
  loader: DocumentLoader,
  timeoutMs: number = REMOTE_FETCH_TIMEOUT_MS,
  overallSignal?: AbortSignal,
): DocumentLoader {
  return (url, options) => {
    const signals = [
      options?.signal,
      AbortSignal.timeout(timeoutMs),
      overallSignal,
    ].filter((signal): signal is AbortSignal => signal != null);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return loader(url, { ...options, signal });
  };
}

export async function readResponseBytesAtMost(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body == null) {
    return new Uint8Array((await response.arrayBuffer()).slice(0, maxBytes));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Stop reading once we have enough bytes for lightweight metadata probing.
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || value == null) break;
      if (total + value.length <= maxBytes) {
        chunks.push(value);
        total += value.length;
        continue;
      }
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
      }
      break;
    }
  } finally {
    // Cancel the unread remainder so Deno closes the underlying HTTP body
    // resource here, with the cancellation awaited (and any rejection
    // swallowed).  Without this, a partially-read body is abandoned with its
    // reader still locked; when the peer tears the keep-alive connection down
    // mid-flight, the dangling read rejects with "resource closed" as a
    // *detached* unhandled rejection that escapes the caller's try/catch and
    // is only caught by the instrument.ts backstop (GRAPHQL-1N).
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

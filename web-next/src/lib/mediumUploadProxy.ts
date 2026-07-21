const UPLOAD_REQUEST_HEADERS = [
  "content-length",
  "content-type",
  "origin",
] as const;

export function createMediumUploadProxyRequest(
  request: Request,
  apiUrl: string,
  uploadId: string,
): Request {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(
    `/medium-uploads/${encodeURIComponent(uploadId)}`,
    apiUrl,
  );
  const token = incomingUrl.searchParams.get("token");
  if (token != null) upstreamUrl.searchParams.set("token", token);
  const headers = new Headers();
  for (const name of UPLOAD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value != null) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.body != null) {
    init.body = request.body;
    // Node's fetch requires this for streaming request bodies.  Deno and
    // browser Request implementations safely ignore the extension.
    init.duplex = "half";
  }
  return new Request(upstreamUrl, init);
}

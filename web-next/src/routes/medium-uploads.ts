import type { APIEvent } from "@solidjs/start/server";
import { getApiUrl } from "~/lib/env.ts";
import { createMediumUploadProxyRequest } from "~/lib/mediumUploadProxy.ts";

export async function PUT({ request }: APIEvent): Promise<Response> {
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (uploadId == null) {
    return new Response("Missing uploadId", { status: 400 });
  }
  return await fetch(
    createMediumUploadProxyRequest(request, getApiUrl(), uploadId),
  );
}

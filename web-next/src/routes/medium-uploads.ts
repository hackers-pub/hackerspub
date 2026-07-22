import { validateUuid } from "@hackerspub/models/uuid";
import type { APIEvent } from "@solidjs/start/server";
import { getApiUrl } from "~/lib/env.ts";
import {
  createMediumUploadPreflightResponse,
  createMediumUploadProxyRequest,
} from "~/lib/mediumUploadProxy.ts";

export function OPTIONS({ request }: APIEvent): Response {
  return createMediumUploadPreflightResponse(request);
}

export async function PUT({ request }: APIEvent): Promise<Response> {
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (uploadId == null || !validateUuid(uploadId)) {
    return new Response("Invalid or missing uploadId", { status: 400 });
  }
  return await fetch(
    createMediumUploadProxyRequest(request, getApiUrl(), uploadId),
  );
}

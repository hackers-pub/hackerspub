import type { APIEvent } from "@solidjs/start/server";
import { getCookie } from "vinxi/http";

export async function POST({ request, nativeEvent }: APIEvent) {
  const sessionId = getCookie(nativeEvent, "session");
  if (!sessionId) {
    return new Response(
      JSON.stringify({ error: "Not authenticated" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const apiUrl = import.meta.env.VITE_API_URL.replace(/\/graphql\/?$/, "");
  const contentType = request.headers.get("Content-Type");

  const response = await fetch(`${apiUrl}/api/media`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${sessionId}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body: request.body,
    // @ts-ignore: duplex is required for streaming request bodies
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ??
        "application/json",
    },
  });
}

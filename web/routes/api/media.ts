import {
  createMediumFromBlob,
  MAX_MEDIUM_IMAGE_SIZE,
  SUPPORTED_MEDIUM_IMAGE_TYPES,
} from "@hackerspub/models/medium";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { define } from "../../utils.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.session == null) {
      return jsonResponse({ error: "Not authenticated" }, 401);
    }

    let formData: FormData;
    try {
      formData = await ctx.req.formData();
    } catch {
      return jsonResponse({ error: "Invalid form data" }, 400);
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonResponse({ error: "No file provided" }, 400);
    }

    if (
      !SUPPORTED_MEDIUM_IMAGE_TYPES.includes(
        file.type as typeof SUPPORTED_MEDIUM_IMAGE_TYPES[number],
      )
    ) {
      return jsonResponse({
        error: "Unsupported image type",
        supported: SUPPORTED_MEDIUM_IMAGE_TYPES,
      }, 400);
    }

    if (file.size > MAX_MEDIUM_IMAGE_SIZE) {
      return jsonResponse(
        { error: "File too large", maxSize: MAX_MEDIUM_IMAGE_SIZE },
        400,
      );
    }

    const disk = drive.use();
    const result = await createMediumFromBlob(db, disk, file);
    if (result == null) {
      return jsonResponse({ error: "Failed to process image" }, 500);
    }

    return jsonResponse({
      mediumId: result.id,
      url: await disk.getUrl(result.key),
      width: result.width,
      height: result.height,
    });
  },
});

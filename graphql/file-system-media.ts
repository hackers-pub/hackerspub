import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";

export async function handleFileSystemMedia(
  request: Request,
  fileSystemRoot: URL | undefined,
): Promise<Response | null> {
  if (fileSystemRoot == null) return null;
  if (!new URL(request.url).pathname.startsWith("/media/")) return null;
  return await serveDir(request, {
    urlRoot: "media",
    fsRoot: fromFileUrl(fileSystemRoot),
  });
}

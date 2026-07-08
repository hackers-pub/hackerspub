const supportedImageContentTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

const contentTypeByExtension = new Map<string, SupportedImageContentType>([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export type SupportedImageContentType =
  typeof supportedImageContentTypes[number];

export const supportedImageMimeAccept = supportedImageContentTypes.join(",");

export const supportedImageAccept = [
  ...supportedImageContentTypes,
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
].join(",");

export function getSupportedImageContentType(
  file: Pick<File, "name" | "type">,
): SupportedImageContentType | null {
  const contentType = file.type.split(";")[0]?.trim().toLowerCase();
  if (
    supportedImageContentTypes.includes(
      contentType as SupportedImageContentType,
    )
  ) {
    return contentType as SupportedImageContentType;
  }
  if (contentType !== "" && contentType !== "application/octet-stream") {
    return null;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension == null ? null : (contentTypeByExtension.get(extension) ??
    null);
}

export function isSupportedImageFile(file: Pick<File, "name" | "type">) {
  return getSupportedImageContentType(file) != null;
}

export function hasSupportedImageContentType(
  file: Pick<File, "type">,
): boolean {
  const contentType = file.type.split(";")[0]?.trim().toLowerCase();
  return supportedImageContentTypes.includes(
    contentType as SupportedImageContentType,
  );
}

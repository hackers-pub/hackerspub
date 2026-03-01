import type { Disk } from "flydrive";
import sharp from "sharp";

export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export interface UploadedImage {
  key: string;
  url: string;
  width: number;
  height: number;
}

export async function uploadImage(
  disk: Disk,
  blob: Blob,
): Promise<UploadedImage | undefined> {
  const { data, info } = await sharp(await blob.arrayBuffer())
    .rotate()
    .webp({ animated: true })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width == null || height == null) return undefined;
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(data),
  );
  const hashHex = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `media/${hashHex}.webp`;
  await disk.put(key, data);
  const url = await disk.getUrl(key);
  return { key, url, width, height };
}

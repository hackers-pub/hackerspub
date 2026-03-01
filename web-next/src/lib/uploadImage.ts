export interface ImageUploadResult {
  url: string;
  width: number;
  height: number;
}

export async function uploadImage(file: File): Promise<ImageUploadResult> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/media", {
    method: "POST",
    body: formData,
    credentials: "include",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Upload failed",
    })) as { error?: string };
    throw new Error(error.error || "Upload failed");
  }

  return response.json();
}

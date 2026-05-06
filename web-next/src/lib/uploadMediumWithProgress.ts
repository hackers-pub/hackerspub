import {
  finishMediumUploadOnServer,
  type MediumUploadResult,
  startMediumUploadOnServer,
} from "~/lib/uploadImage.ts";

export type { MediumUploadResult };

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function xhrUpload(
  method: string,
  url: string,
  data: Blob,
  headers: { name: string; value: string }[],
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    for (const { name, value } of headers) {
      xhr.setRequestHeader(name, value);
    }
    if (onProgress != null) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.onabort = () => reject(new Error("Upload was aborted"));
    xhr.send(data);
  });
}

export async function uploadMediumFile(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<MediumUploadResult> {
  const session = await startMediumUploadOnServer(file.size, file.type);
  await xhrUpload(
    session.method,
    session.uploadUrl,
    file,
    session.headers,
    onProgress,
  );
  return await finishMediumUploadOnServer(session.uploadId);
}

import {
  finishMediumUploadOnServer,
  type MediumUploadResult,
  startMediumUploadOnServer,
} from "~/lib/uploadImage.ts";

export type { MediumUploadResult };

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class UploadAbortedError extends Error {
  constructor() {
    super("Upload was aborted");
  }
}

function xhrUpload(
  method: string,
  url: string,
  data: Blob,
  headers: { name: string; value: string }[],
  signal: AbortSignal,
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
      } else if (xhr.status === 413) {
        reject(new Error(`File is too large (status 413)`));
      } else if (xhr.status === 415) {
        reject(new Error(`File type is not supported (status 415)`));
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.onabort = () => reject(new UploadAbortedError());

    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(data);
  });
}

export interface UploadHandle {
  result: Promise<MediumUploadResult>;
  abort: () => void;
}

export function uploadMediumFile(
  file: File,
  onProgress?: (progress: number) => void,
): UploadHandle {
  const controller = new AbortController();

  const result = (async () => {
    const session = await startMediumUploadOnServer(file.size, file.type);
    if (controller.signal.aborted) throw new UploadAbortedError();
    await xhrUpload(
      session.method,
      session.uploadUrl,
      file,
      session.headers,
      controller.signal,
      onProgress,
    );
    if (controller.signal.aborted) throw new UploadAbortedError();
    return await finishMediumUploadOnServer(session.uploadId);
  })();

  return { result, abort: () => controller.abort() };
}

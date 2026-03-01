import { getRequestEvent } from "solid-js/web";
import { getCookie } from "vinxi/http";

export interface ImageUploadResult {
  url: string;
  width: number;
  height: number;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadMediaOnServer(
  mediaUrl: string,
): Promise<ImageUploadResult> {
  "use server";

  const event = getRequestEvent();
  const sessionId = event == null
    ? null
    : getCookie(event.nativeEvent, "session");

  const response = await fetch(import.meta.env.VITE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(sessionId == null ? {} : { Authorization: `Bearer ${sessionId}` }),
    },
    body: JSON.stringify({
      query: `
        mutation uploadMedia($input: UploadMediaInput!) {
          uploadMedia(input: $input) {
            __typename
            ... on UploadMediaPayload {
              url
              width
              height
            }
            ... on InvalidInputError {
              inputPath
            }
            ... on NotAuthenticatedError {
              notAuthenticated
            }
          }
        }
      `,
      variables: {
        input: { mediaUrl },
      },
    }),
  });

  const result = await response.json() as {
    errors?: { message: string }[];
    data?: {
      uploadMedia: {
        __typename: string;
        url?: string;
        width?: number;
        height?: number;
        inputPath?: string;
      };
    };
  };

  if (result.errors) {
    throw new Error(result.errors[0]?.message || "Upload failed");
  }

  const data = result.data?.uploadMedia;
  if (data == null) {
    throw new Error("Upload failed");
  }

  if (data.__typename === "UploadMediaPayload") {
    return { url: data.url!, width: data.width!, height: data.height! };
  } else if (data.__typename === "NotAuthenticatedError") {
    throw new Error("Not authenticated");
  }

  throw new Error("Upload failed");
}

export async function uploadImage(file: File): Promise<ImageUploadResult> {
  const dataUrl = await fileToDataUrl(file);
  return uploadMediaOnServer(dataUrl);
}

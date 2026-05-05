import { getRequestEvent } from "solid-js/web";
import { getApiUrl } from "~/lib/env.ts";

export interface ImageUploadResult {
  uuid: string;
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

function readSessionCookie(request: Request | undefined): string | null {
  const cookieHeader = request?.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "session") continue;
    const raw = part.slice(eq + 1).trim();
    return raw ? decodeURIComponent(raw) : null;
  }
  return null;
}

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  "use server";

  const event = getRequestEvent();
  const sessionId = readSessionCookie(event?.request);
  const response = await fetch(getApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(sessionId == null ? {} : { Authorization: `Bearer ${sessionId}` }),
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const result = await response.json() as T & {
    errors?: { message: string }[];
  };
  if (result.errors) {
    throw new Error(result.errors[0]?.message || "Upload failed");
  }
  return result;
}

export async function createMediumFromDataUrl(
  url: string,
): Promise<ImageUploadResult> {
  "use server";

  const result = await graphqlRequest<{
    data?: {
      createMedium: {
        __typename: string;
        medium?: {
          uuid: string;
          url: string;
          width: number | null;
          height: number | null;
        };
        inputPath?: string;
      };
    };
    errors?: { message: string }[];
  }>(
    `
      mutation createMedium($input: CreateMediumInput!) {
        createMedium(input: $input) {
          __typename
          ... on CreateMediumPayload {
            medium {
              uuid
              url
              width
              height
            }
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
    { input: { url } },
  );

  const data = result.data?.createMedium;
  if (data == null) {
    throw new Error("Upload failed");
  }
  if (data.__typename === "CreateMediumPayload" && data.medium != null) {
    return {
      uuid: data.medium.uuid,
      url: data.medium.url,
      width: data.medium.width ?? 0,
      height: data.medium.height ?? 0,
    };
  }
  if (data.__typename === "NotAuthenticatedError") {
    throw new Error("Not authenticated");
  }
  throw new Error("Upload failed");
}

async function attachArticleDraftMediumOnServer(
  draftId: string,
  mediumId: string,
): Promise<string> {
  "use server";

  const result = await graphqlRequest<{
    data?: {
      attachArticleDraftMedium: {
        __typename: string;
        key?: string;
        inputPath?: string;
      };
    };
    errors?: { message: string }[];
  }>(
    `
      mutation attachArticleDraftMedium($input: AttachArticleDraftMediumInput!) {
        attachArticleDraftMedium(input: $input) {
          __typename
          ... on AttachArticleDraftMediumPayload {
            key
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
    { input: { draftId, mediumId } },
  );

  const data = result.data?.attachArticleDraftMedium;
  if (data == null) throw new Error("Upload failed");
  if (data.__typename === "AttachArticleDraftMediumPayload" && data.key) {
    return data.key;
  }
  if (data.__typename === "NotAuthenticatedError") {
    throw new Error("Not authenticated");
  }
  throw new Error("Upload failed");
}

export async function uploadImage(
  file: File,
  draftId?: string,
): Promise<ImageUploadResult> {
  const dataUrl = await fileToDataUrl(file);
  const medium = await createMediumFromDataUrl(dataUrl);
  if (draftId == null) return medium;
  const key = await attachArticleDraftMediumOnServer(draftId, medium.uuid);
  return { ...medium, url: `hp-medium:${key}` };
}

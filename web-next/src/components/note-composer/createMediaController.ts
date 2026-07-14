import { fetchQuery, graphql, type IEnvironment } from "relay-runtime";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { createMediaControllerDraftMediaQuery } from "./__generated__/createMediaControllerDraftMediaQuery.graphql.ts";
import type { createMediaControllerGeneratedAltTextQuery } from "./__generated__/createMediaControllerGeneratedAltTextQuery.graphql.ts";
import { type MediaItem, reduceMediaItems } from "./mediaState.ts";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { NoteDraftMedia } from "~/lib/noteDraftStorage.ts";
import {
  getSupportedImageContentType,
  isSupportedImageFile,
} from "~/lib/supportedImageFile.ts";
import {
  UploadAbortedError,
  uploadMediumFile,
} from "~/lib/uploadMediumWithProgress.ts";

const DraftMediaQuery = graphql`
  query createMediaControllerDraftMediaQuery($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Medium {
        id
        uuid
        url
        width
        height
      }
    }
  }
`;

const GeneratedAltTextQuery = graphql`
  query createMediaControllerGeneratedAltTextQuery(
    $mediumId: ID!
    $language: Locale!
    $context: String
  ) {
    node(id: $mediumId) {
      ... on Medium {
        generatedAltText(language: $language, context: $context)
      }
    }
  }
`;

export const MAX_MEDIA = 20;

export interface MediaControllerOptions {
  readonly environment: Accessor<IEnvironment>;
  readonly editing: Accessor<boolean>;
  readonly language: Accessor<string>;
  readonly content: Accessor<string>;
}

export interface MediaController {
  readonly items: Accessor<readonly MediaItem[]>;
  readonly addFiles: (files: FileList | readonly File[]) => void;
  readonly restore: (media: readonly NoteDraftMedia[]) => void;
  readonly setAlt: (localId: string, alt: string) => void;
  readonly generateAlt: (localId: string) => void;
  readonly cancelAlt: (localId: string) => void;
  readonly remove: (localId: string) => void;
  readonly reset: () => void;
}

export function createMediaController(
  options: MediaControllerOptions,
): MediaController {
  const { t } = useLingui();
  const [items, setItems] = createSignal<readonly MediaItem[]>([]);
  let restoreSubscription: { unsubscribe(): void } | undefined;

  const dispatch = (
    action: Parameters<typeof reduceMediaItems>[1],
  ) => setItems((current) => reduceMediaItems(current, action));

  const disposeItem = (item: MediaItem) => {
    item.abortUpload?.();
    item.altSubscription?.unsubscribe();
    revokePreviewUrl(item.previewUrl);
  };

  const reset = () => {
    restoreSubscription?.unsubscribe();
    restoreSubscription = undefined;
    for (const item of items()) disposeItem(item);
    dispatch({ type: "replace", items: [] });
  };

  const remove = (localId: string) => {
    const item = items().find((candidate) => candidate.localId === localId);
    if (item == null) return;
    disposeItem(item);
    dispatch({ type: "remove", localId });
  };

  const addFiles = (files: FileList | readonly File[]) => {
    if (options.editing()) return;
    const supported = Array.from(files).filter(isSupportedImageFile);
    if (supported.length === 0) return;

    const remaining = MAX_MEDIA - items().length;
    if (remaining <= 0) {
      showToast({
        title: t`Error`,
        description: t`You can attach up to ${MAX_MEDIA} images`,
        variant: "error",
      });
      return;
    }

    const selected = supported.slice(0, remaining);
    if (selected.length < supported.length) {
      showToast({
        title: t`Warning`,
        description:
          t`Some images were skipped because the limit of ${MAX_MEDIA} was reached`,
        variant: "warning",
      });
    }

    const newItems = selected.map((file): MediaItem => {
      const localId = createLocalId();
      const contentType = getSupportedImageContentType(file);
      if (contentType == null) {
        throw new Error("Expected supported image content type");
      }
      const handle = uploadMediumFile(file, contentType, (progress) => {
        dispatch({ type: "upload-progress", localId, progress });
      });
      handle.result.then((result) => {
        dispatch({ type: "upload-completed", localId, result });
      }).catch((error) => {
        if (error instanceof UploadAbortedError) return;
        const failed = items().find((item) => item.localId === localId);
        if (failed != null) {
          revokePreviewUrl(failed.previewUrl);
          dispatch({ type: "remove", localId });
        }
        showToast({
          title: t`Error`,
          description: error instanceof Error && error.message
            ? error.message
            : t`Failed to upload image`,
          variant: "error",
        });
      });
      return {
        localId,
        file,
        previewUrl: URL.createObjectURL(file),
        alt: "",
        uploading: true,
        uploadProgress: 0,
        generatingAlt: false,
        abortUpload: handle.abort,
      };
    });
    dispatch({ type: "append", items: newItems });
  };

  const restore = (media: readonly NoteDraftMedia[]) => {
    reset();
    if (media.length < 1) return;
    dispatch({
      type: "replace",
      items: media.map((item) => ({
        localId: item.localId,
        previewUrl: item.url,
        alt: item.alt,
        mediumRelayId: item.mediumRelayId,
        uuid: item.uuid,
        url: item.url,
        width: item.width,
        height: item.height,
        uploading: false,
        uploadProgress: 100,
        generatingAlt: false,
      })),
    });
    const storedById = new Map(media.map((item) => [item.mediumRelayId, item]));
    restoreSubscription = fetchQuery<createMediaControllerDraftMediaQuery>(
      options.environment(),
      DraftMediaQuery,
      { ids: media.map((item) => item.mediumRelayId) },
    ).subscribe({
      next(data) {
        const restored = (data.nodes ?? []).flatMap((node) => {
          if (
            node == null || node.id == null || node.uuid == null ||
            node.url == null
          ) {
            return [];
          }
          const stored = storedById.get(node.id);
          if (stored == null) return [];
          return [
            {
              localId: stored.localId,
              previewUrl: node.url.toString(),
              alt: stored.alt,
              mediumRelayId: node.id,
              uuid: node.uuid,
              url: node.url.toString(),
              width: node.width ?? undefined,
              height: node.height ?? undefined,
              uploading: false,
              uploadProgress: 100,
              generatingAlt: false,
            } satisfies MediaItem,
          ];
        });
        if (restored.length < media.length) {
          showToast({
            title: t`Warning`,
            description:
              t`Some locally saved images are no longer available and were removed from the draft.`,
            variant: "warning",
          });
        }
        dispatch({ type: "replace", items: restored });
      },
      error() {
        showToast({
          title: t`Warning`,
          description:
            t`Could not verify locally saved images. They may fail when you post.`,
          variant: "warning",
        });
      },
    });
  };

  const generateAlt = (localId: string) => {
    const item = items().find((candidate) => candidate.localId === localId);
    if (item?.mediumRelayId == null) return;
    dispatch({ type: "alt-started", localId });
    const subscription = fetchQuery<createMediaControllerGeneratedAltTextQuery>(
      options.environment(),
      GeneratedAltTextQuery,
      {
        mediumId: item.mediumRelayId,
        language: options.language(),
        context: options.content().trim() || undefined,
      },
    ).subscribe({
      next(data) {
        const medium = data.node;
        dispatch({
          type: "alt-completed",
          localId,
          alt: medium && "generatedAltText" in medium
            ? (medium.generatedAltText ?? null)
            : null,
        });
      },
      error(error: Error) {
        dispatch({ type: "alt-completed", localId, alt: null });
        showToast({
          title: t`Error`,
          description: error?.message || t`Failed to generate alt text`,
          variant: "error",
        });
      },
    });
    dispatch({
      type: "alt-subscription-set",
      localId,
      subscription,
    });
  };

  const cancelAlt = (localId: string) => {
    const item = items().find((candidate) => candidate.localId === localId);
    item?.altSubscription?.unsubscribe();
    dispatch({ type: "alt-cancelled", localId });
  };

  onCleanup(() => {
    restoreSubscription?.unsubscribe();
    for (const item of items()) disposeItem(item);
  });

  return {
    items,
    addFiles,
    restore,
    setAlt: (localId, alt) => dispatch({ type: "alt-changed", localId, alt }),
    generateAlt,
    cancelAlt,
    remove,
    reset,
  };
}

function createLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
}

function revokePreviewUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

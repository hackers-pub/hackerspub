export interface MediaSubscription {
  unsubscribe(): void;
}

export interface MediaItem {
  readonly localId: string;
  readonly file?: File;
  readonly previewUrl: string;
  readonly alt: string;
  readonly mediumRelayId?: string;
  readonly uuid?: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly uploading: boolean;
  readonly uploadProgress: number;
  readonly generatingAlt: boolean;
  readonly abortUpload?: () => void;
  readonly altSubscription?: MediaSubscription;
}

export interface CompletedMediaUpload {
  readonly uuid: string;
  readonly mediumRelayId: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

export type MediaStateAction =
  | { readonly type: "append"; readonly items: readonly MediaItem[] }
  | { readonly type: "replace"; readonly items: readonly MediaItem[] }
  | {
    readonly type: "upload-progress";
    readonly localId: string;
    readonly progress: number;
  }
  | {
    readonly type: "upload-completed";
    readonly localId: string;
    readonly result: CompletedMediaUpload;
  }
  | {
    readonly type: "alt-changed";
    readonly localId: string;
    readonly alt: string;
  }
  | {
    readonly type: "alt-started";
    readonly localId: string;
  }
  | {
    readonly type: "alt-subscription-set";
    readonly localId: string;
    readonly subscription: MediaSubscription;
  }
  | {
    readonly type: "alt-completed";
    readonly localId: string;
    readonly alt: string | null;
  }
  | {
    readonly type: "alt-cancelled";
    readonly localId: string;
  }
  | { readonly type: "remove"; readonly localId: string };

export function reduceMediaItems(
  items: readonly MediaItem[],
  action: MediaStateAction,
): readonly MediaItem[] {
  switch (action.type) {
    case "append":
      return [...items, ...action.items];
    case "replace":
      return [...action.items];
    case "remove":
      return items.filter((item) => item.localId !== action.localId);
    case "upload-progress":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        uploadProgress: action.progress,
      }));
    case "upload-completed":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        uploading: false,
        uploadProgress: 100,
        uuid: action.result.uuid,
        mediumRelayId: action.result.mediumRelayId,
        url: action.result.url,
        width: action.result.width,
        height: action.result.height,
        abortUpload: undefined,
      }));
    case "alt-changed":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        alt: action.alt,
      }));
    case "alt-started":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        generatingAlt: true,
      }));
    case "alt-subscription-set":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        altSubscription: action.subscription,
      }));
    case "alt-completed":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        generatingAlt: false,
        alt: action.alt ?? item.alt,
        altSubscription: undefined,
      }));
    case "alt-cancelled":
      return updateItem(items, action.localId, (item) => ({
        ...item,
        generatingAlt: false,
        altSubscription: undefined,
      }));
  }
}

function updateItem(
  items: readonly MediaItem[],
  localId: string,
  update: (item: MediaItem) => MediaItem,
): readonly MediaItem[] {
  let found = false;
  const updated = items.map((item) => {
    if (item.localId !== localId) return item;
    found = true;
    return update(item);
  });
  return found ? updated : items;
}

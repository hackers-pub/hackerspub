import type { PostMedium } from "@hackerspub/models/schema";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

export interface MediumThumbnailProps {
  medium: PostMedium;
  class?: string;
}

type EnrichedPostMedium = PostMedium & {
  thumbnailUrl: string | null;
};

export function MediumThumbnail(
  { medium, class: klass }: MediumThumbnailProps,
) {
  const [zoomed, setZoomed] = useState(false);
  const [showingFullAltText, setShowingFullAltText] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>(
    medium.type.startsWith("image/") ? medium.url : undefined,
  );

  useEffect(() => {
    if (medium.thumbnailKey == null) return;
    fetch(`/api/posts/${medium.postId}/media/${medium.index}`)
      .then((response) => response.json())
      .then((data: EnrichedPostMedium) => {
        setThumbnailUrl(data.thumbnailUrl ?? undefined);
      });
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  });

  function onZoomIn(event: JSX.TargetedMouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setZoomed(true);
  }

  function onZoomOut(event: JSX.TargetedMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    if ((event.target as HTMLElement).tagName === "DIV") {
      setZoomed(false);
    }
  }

  function isTextInNodeSelected(node: HTMLElement): boolean {
    const selection = getSelection();
    if (!selection) {
      return false;
    }
    if (selection.type != "Range") {
      return false;
    }
    return selection.containsNode(node, true);
  }

  function onShowFullAltText(event: JSX.TargetedMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const eventTarget = event.target as HTMLElement;
    if (eventTarget.offsetHeight >= eventTarget.scrollHeight) {
      // `text-overflow: ellipsis` is not applied.
      return;
    }
    if (!isTextInNodeSelected(event.target as HTMLElement)) {
      setShowingFullAltText(true);
    }
  }

  function onShowCollapsedAltText(
    event: JSX.TargetedMouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    if (!isTextInNodeSelected(event.target as HTMLElement)) {
      setShowingFullAltText(false);
    }
  }

  const width = medium.width ?? undefined;
  const height = medium.height ?? undefined;
  const sizeProvided = width != null && height != null;
  const altLines = medium.alt == null ? undefined : medium.alt.split("\n");

  return (
    <>
      <a
        href={medium.url}
        target="_blank"
        onClick={onZoomIn}
        class={klass ?? ""}
      >
        {thumbnailUrl == null
          ? (
            <div class="mt-2 object-contain max-w-96 max-h-96">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-6"
                width={medium.width ?? undefined}
                height={medium.height ?? undefined}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
            </div>
          )
          : (
            <img
              src={thumbnailUrl}
              alt={medium.alt ?? ""}
              width={medium.width ?? undefined}
              height={medium.height ?? undefined}
              class="mt-2 object-contain max-w-96 max-h-96"
            />
          )}
      </a>
      {zoomed && (
        <div
          class="fixed z-50 left-0 top-0 bg-[rgba(0,0,0,0.75)] text-stone-100 w-full h-full flex flex-col items-center justify-center"
          onClick={onZoomOut}
        >
          {medium.type.startsWith("video/")
            ? (
              <video
                src={medium.url}
                autoplay
                controls
                width={sizeProvided ? width : undefined}
                height={sizeProvided ? height : undefined}
                style={{
                  maxHeight: `calc(100% - ${altLines == null ? 2 : 10}rem)`,
                }}
                class="w-auto"
              />
            )
            : (
              <img
                src={medium.url}
                alt={medium.alt ?? ""}
                width={sizeProvided ? width : undefined}
                height={sizeProvided ? height : undefined}
                style={{
                  maxHeight: `calc(100% - ${altLines == null ? 2 : 10}rem)`,
                }}
                class="w-auto"
              />
            )}
          {altLines && (
            showingFullAltText
              ? (
                <div
                  key="fullAltText"
                  class="fixed p-4 w-full h-full bottom-0 bg-[rgba(0,0,0,0.75)] overflow-y-scroll"
                  onClick={onShowCollapsedAltText}
                >
                  <p>
                    {altLines.map((line, i) =>
                      i < 1 ? line : (
                        <>
                          <br />
                          {line}
                        </>
                      )
                    )}
                  </p>
                </div>
              )
              : (
                <div
                  key="collapsedAltText"
                  class="mt-4 px-4 w-full line-clamp-4 text-ellipsis overflow-hidden"
                  style={{
                    maxHeight: "8rem",
                  }}
                  onClick={onShowFullAltText}
                >
                  <p>
                    {altLines.map((line, i) =>
                      i < 1 ? line : (
                        <>
                          <br />
                          {line}
                        </>
                      )
                    )}
                  </p>
                </div>
              )
          )}
        </div>
      )}
    </>
  );
}

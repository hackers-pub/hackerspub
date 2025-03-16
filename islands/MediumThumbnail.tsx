import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PostMedium } from "../models/schema.ts";

export interface MediumThumbnailProps {
  medium: PostMedium;
}

export function MediumThumbnail({ medium }: MediumThumbnailProps) {
  const [zoomed, setZoomed] = useState(false);

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

  const width = medium.width ?? undefined;
  const height = medium.height ?? undefined;
  const sizeProvided = width != null && height != null;
  const altLines = medium.alt == null ? undefined : medium.alt.split("\n");

  return (
    <>
      <a href={medium.url} target="_blank" onClick={onZoomIn}>
        <img
          src={medium.url}
          alt={medium.alt ?? ""}
          width={medium.width ?? undefined}
          height={medium.height ?? undefined}
          class="mt-2 object-contain max-w-96 max-h-96"
        />
      </a>
      {zoomed && (
        <div
          class="fixed z-50 left-0 top-0 bg-[rgba(0,0,0,0.75)] text-stone-100 w-full h-full flex flex-col items-center justify-center"
          onClick={onZoomOut}
        >
          <img
            src={medium.url}
            alt={medium.alt ?? ""}
            width={sizeProvided ? width : undefined}
            height={sizeProvided ? height : undefined}
            style={{
              maxHeight: `calc(100% - ${
                altLines == null ? 2 : altLines.length * 2 + 2
              }rem)`,
            }}
            class="w-auto"
          />
          {altLines && (
            <p class="mt-4 text-center">
              {altLines.map((line, i) =>
                i < 1 ? line : (
                  <>
                    <br />
                    {line}
                  </>
                )
              )}
            </p>
          )}
        </div>
      )}
    </>
  );
}

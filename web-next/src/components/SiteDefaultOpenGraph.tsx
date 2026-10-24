import { Meta } from "@solidjs/meta";
import { getRequestEvent, isServer } from "solid-js/web";

const SITE_PREVIEW_IMAGE_PATH = "/og.png";
const SITE_PREVIEW_IMAGE_WIDTH = "1600";
const SITE_PREVIEW_IMAGE_HEIGHT = "840";

export interface SiteDefaultOpenGraphProps {
  title: string;
}

function currentSiteOrigin(): string {
  if (!isServer) return globalThis.location.origin;
  const event = getRequestEvent();
  return (
    process.env.ORIGIN ??
    (event == null ? "https://hackers.pub" : new URL(event.request.url).origin)
  );
}

export function SiteDefaultOpenGraph(props: SiteDefaultOpenGraphProps) {
  const sitePreviewImageUrl = () =>
    new URL(SITE_PREVIEW_IMAGE_PATH, currentSiteOrigin()).href;
  return (
    <>
      <Meta property="og:site_name" content="Hackers' Pub" />
      <Meta property="og:type" content="website" />
      <Meta property="og:title" content={props.title} />
      <Meta property="og:image" content={sitePreviewImageUrl()} />
      <Meta property="og:image:width" content={SITE_PREVIEW_IMAGE_WIDTH} />
      <Meta property="og:image:height" content={SITE_PREVIEW_IMAGE_HEIGHT} />
      <Meta property="og:image:alt" content="Hackers' Pub" />
      <Meta name="twitter:card" content="summary_large_image" />
    </>
  );
}

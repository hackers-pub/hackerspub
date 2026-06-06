const DEFAULT_FAVICON_HREF = "/favicon.svg";

export const UNREAD_FAVICON_BADGE_ID = "hackerspub-unread-notifications-badge";

export function buildUnreadNotificationsFaviconSvg(sourceSvg: string): string {
  if (!/<svg\b/i.test(sourceSvg) || !/<\/svg>/i.test(sourceSvg)) {
    throw new Error("Failed to find favicon SVG root.");
  }

  const faviconWithoutBadge = sourceSvg.replace(
    new RegExp(
      `<g\\b[^>]*\\bid=["']${UNREAD_FAVICON_BADGE_ID}["'][^>]*>[\\s\\S]*?<\\/g>`,
      "g",
    ),
    "",
  );
  const badgeInsertionIndex = faviconWithoutBadge.toLowerCase().lastIndexOf(
    "</svg>",
  );

  return `${faviconWithoutBadge.slice(0, badgeInsertionIndex)}${
    buildUnreadBadgeMarkup(getBadgeGeometry(faviconWithoutBadge))
  }${faviconWithoutBadge.slice(badgeInsertionIndex)}`;
}

export function createUnreadNotificationsFaviconHref(
  sourceSvg: string,
): string {
  return `data:image/svg+xml,${
    encodeURIComponent(buildUnreadNotificationsFaviconSvg(sourceSvg))
  }`;
}

export function createUnreadNotificationsFaviconBadgeController(): {
  setUnread(hasUnreadNotifications: boolean): Promise<void>;
  dispose(): void;
} {
  let requestVersion = 0;
  let defaultHref: string | null = null;
  let badgedHref: Promise<string> | null = null;

  return {
    async setUnread(hasUnreadNotifications: boolean): Promise<void> {
      const link = getSvgFaviconLink(document);
      defaultHref ??= getDefaultFaviconHref(link);
      link.setAttribute("data-default-favicon-href", defaultHref);

      const version = ++requestVersion;
      if (!hasUnreadNotifications) {
        link.setAttribute("href", defaultHref);
        return;
      }

      badgedHref ??= fetch(defaultHref)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(
              `Failed to load favicon SVG: ${response.status} ${response.statusText}`,
            );
          }
          return createUnreadNotificationsFaviconHref(await response.text());
        })
        .catch((error: unknown) => {
          badgedHref = null;
          throw error;
        });

      const href = await badgedHref;
      if (version === requestVersion) {
        link.setAttribute("href", href);
      }
    },

    dispose(): void {
      requestVersion++;
      const link = getSvgFaviconLink(document);
      link.setAttribute("href", defaultHref ?? getDefaultFaviconHref(link));
    },
  };
}

function getDefaultFaviconHref(link: HTMLLinkElement): string {
  return link.getAttribute("data-default-favicon-href") ??
    link.getAttribute("href") ??
    DEFAULT_FAVICON_HREF;
}

function getSvgFaviconLink(document: Document): HTMLLinkElement {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel~="icon"][type="image/svg+xml"]',
  );
  if (link != null) return link;

  const newLink = document.createElement("link");
  newLink.rel = "icon";
  newLink.type = "image/svg+xml";
  newLink.setAttribute("href", DEFAULT_FAVICON_HREF);
  document.head.appendChild(newLink);
  return newLink;
}

function buildUnreadBadgeMarkup(
  { cx, cy, radius, ringRadius }: ReturnType<typeof getBadgeGeometry>,
): string {
  return `<g id="${UNREAD_FAVICON_BADGE_ID}" aria-hidden="true">` +
    `<circle cx="${cx}" cy="${cy}" r="${ringRadius}" fill="#ffffff"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#ef4444"/>` +
    `</g>`;
}

function getBadgeGeometry(sourceSvg: string): {
  cx: number;
  cy: number;
  radius: number;
  ringRadius: number;
} {
  const [minX, minY, width, height] = parseViewBox(sourceSvg) ?? [0, 0, 32, 32];
  const shortestSide = Math.min(width, height);
  const radius = round(shortestSide * 0.14);
  const ringRadius = round(shortestSide * 0.19);

  return {
    cx: round(minX + width - ringRadius * 0.9),
    cy: round(minY + ringRadius * 0.9),
    radius,
    ringRadius,
  };
}

function parseViewBox(
  sourceSvg: string,
): [number, number, number, number] | null {
  const viewBox = sourceSvg.match(/\bviewBox=["']([^"']+)["']/)?.[1]?.trim();
  if (viewBox == null || viewBox === "") return null;

  const values = viewBox.split(/\s+/).map((value) => Number(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const [minX, minY, width, height] = values;
  if (width <= 0 || height <= 0) return null;
  return [minX, minY, width, height];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface MediaType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: ReadonlyMap<string, string>;
}

const activityStreamsProfile = "https://www.w3.org/ns/activitystreams";

const activityPubMediaTypes: readonly MediaType[] = [
  { type: "application", subtype: "activity+json", parameters: new Map() },
  {
    type: "application",
    subtype: "ld+json",
    parameters: new Map([["profile", activityStreamsProfile]]),
  },
];

const htmlMediaTypes: readonly MediaType[] = [
  { type: "text", subtype: "html", parameters: new Map() },
  { type: "application", subtype: "xhtml+xml", parameters: new Map() },
];

interface MediaRange extends MediaType {
  readonly quality: number;
  readonly order: number;
}

interface MediaPreference {
  readonly quality: number;
  readonly typeSpecificity: number;
  readonly parameterSpecificity: number;
  readonly order: number;
}

export interface ActivityPubAlternate {
  readonly url: URL;
  readonly mediaType: string;
}

function splitHeaderValue(value: string, delimiter: string): string[] {
  const values: string[] = [];
  let start = 0;
  let escaped = false;
  let quoted = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "<") angleDepth++;
    else if (character === ">" && angleDepth > 0) angleDepth--;
    else if (character === delimiter && angleDepth === 0) {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  values.push(value.slice(start).trim());
  return values.filter((part) => part !== "");
}

function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replaceAll(/\\(.)/g, "$1");
}

function parseMediaType(
  value: string,
  allowWildcards: boolean,
): MediaType | null {
  const [mediaType, ...rawParameters] = splitHeaderValue(value, ";");
  const [type, subtype, extra] = mediaType.toLowerCase().split("/");
  if (
    type == null ||
    type === "" ||
    subtype == null ||
    subtype === "" ||
    extra != null ||
    (!allowWildcards && (type === "*" || subtype === "*")) ||
    (type === "*" && subtype !== "*")
  ) {
    return null;
  }

  const parameters = new Map<string, string>();
  for (const parameter of rawParameters) {
    const separator = parameter.indexOf("=");
    if (separator < 1) return null;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name === "" || parameters.has(name)) return null;
    parameters.set(name, unquote(parameter.slice(separator + 1).trim()));
  }

  return { type, subtype, parameters };
}

function parseAccept(accept: string): MediaRange[] {
  return splitHeaderValue(accept, ",").flatMap((value, order) => {
    const mediaRange = parseMediaType(value, true);
    if (mediaRange == null) return [];
    const parameters = new Map(mediaRange.parameters);
    const rawQuality = parameters.get("q");
    parameters.delete("q");
    const quality = rawQuality == null ? 1 : Number(rawQuality);
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) return [];

    return [{ ...mediaRange, parameters, quality, order }];
  });
}

function parametersMatch(range: MediaRange, mediaType: MediaType): boolean {
  for (const [name, value] of range.parameters) {
    if (mediaType.parameters.get(name) !== value) return false;
  }
  return true;
}

function getPreference(
  mediaType: MediaType,
  ranges: readonly MediaRange[],
): MediaPreference {
  let preference: MediaPreference = {
    quality: 0,
    typeSpecificity: -1,
    parameterSpecificity: -1,
    order: Number.MAX_SAFE_INTEGER,
  };

  for (const range of ranges) {
    if (range.type !== "*" && range.type !== mediaType.type) continue;
    if (range.subtype !== "*" && range.subtype !== mediaType.subtype) continue;
    if (!parametersMatch(range, mediaType)) continue;
    const typeSpecificity =
      Number(range.type !== "*") + Number(range.subtype !== "*");
    if (
      typeSpecificity > preference.typeSpecificity ||
      (typeSpecificity === preference.typeSpecificity &&
        range.parameters.size > preference.parameterSpecificity) ||
      (typeSpecificity === preference.typeSpecificity &&
        range.parameters.size === preference.parameterSpecificity &&
        range.order < preference.order)
    ) {
      preference = {
        quality: range.quality,
        typeSpecificity,
        parameterSpecificity: range.parameters.size,
        order: range.order,
      };
    }
  }

  return preference;
}

function comparePreferences(
  left: MediaPreference,
  right: MediaPreference,
): number {
  return (
    left.quality - right.quality ||
    left.typeSpecificity - right.typeSpecificity ||
    left.parameterSpecificity - right.parameterSpecificity ||
    right.order - left.order
  );
}

function getBestPreference(
  mediaTypes: Iterable<MediaType>,
  ranges: readonly MediaRange[],
): MediaPreference {
  let best: MediaPreference = {
    quality: 0,
    typeSpecificity: -1,
    parameterSpecificity: -1,
    order: Number.MAX_SAFE_INTEGER,
  };
  for (const mediaType of mediaTypes) {
    const preference = getPreference(mediaType, ranges);
    if (comparePreferences(preference, best) > 0) best = preference;
  }
  return best;
}

export function prefersActivityPub(
  accept: string | null,
  advertisedMediaType: string,
): boolean {
  if (accept == null || accept.trim() === "") return false;
  const activityPubMediaType = parseMediaType(advertisedMediaType, false);
  if (
    activityPubMediaType == null ||
    !isActivityPubMediaType(activityPubMediaType)
  ) {
    return false;
  }
  const ranges = parseAccept(accept);
  const requestedActivityPubTypes = activityPubMediaTypes.filter((mediaType) =>
    ranges.some(
      (range) =>
        range.type === mediaType.type &&
        range.subtype === mediaType.subtype &&
        parametersMatch(range, mediaType),
    ),
  );
  if (requestedActivityPubTypes.length < 1) return false;

  const advertised = getPreference(activityPubMediaType, ranges);
  const activityPub =
    advertised.typeSpecificity < 0
      ? getBestPreference(requestedActivityPubTypes, ranges)
      : advertised;
  const html = getBestPreference(htmlMediaTypes, ranges);
  return activityPub.quality > 0 && comparePreferences(activityPub, html) > 0;
}

function isActivityPubMediaType(mediaType: MediaType): boolean {
  const baseType = `${mediaType.type}/${mediaType.subtype}`;
  return (
    baseType === "application/activity+json" ||
    baseType === "application/ld+json"
  );
}

export function findActivityPubAlternate(
  linkHeader: string | null,
  baseUrl: string,
): ActivityPubAlternate | null {
  if (linkHeader == null) return null;

  for (const value of splitHeaderValue(linkHeader, ",")) {
    const targetMatch = /^<([^>]*)>(.*)$/.exec(value);
    if (targetMatch == null) continue;
    const parameters = new Map<string, string>();
    for (const parameter of splitHeaderValue(targetMatch[2], ";")) {
      const separator = parameter.indexOf("=");
      if (separator < 0) continue;
      parameters.set(
        parameter.slice(0, separator).trim().toLowerCase(),
        unquote(parameter.slice(separator + 1).trim()),
      );
    }
    if (!parameters.get("rel")?.split(/\s+/).includes("alternate")) continue;
    const mediaType = parameters.get("type");
    if (mediaType == null) continue;
    const parsedMediaType = parseMediaType(mediaType, false);
    if (parsedMediaType == null || !isActivityPubMediaType(parsedMediaType)) {
      continue;
    }

    try {
      const target = new URL(targetMatch[1], baseUrl);
      if (target.protocol === "http:" || target.protocol === "https:") {
        return { url: target, mediaType };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function appendVary(headers: Headers, name: string): void {
  const vary = headers.get("Vary");
  if (vary == null || vary.trim() === "") {
    headers.set("Vary", name);
    return;
  }
  const names = vary.split(",").map((value) => value.trim());
  if (
    names.includes("*") ||
    names.some((value) => value.toLowerCase() === name.toLowerCase())
  ) {
    return;
  }
  headers.set("Vary", `${vary}, ${name}`);
}

export function negotiateActivityPubAlternate(
  request: Request,
  responseHeaders: Headers,
): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const alternate = findActivityPubAlternate(
    responseHeaders.get("Link"),
    request.url,
  );
  if (alternate == null) return;

  appendVary(responseHeaders, "Accept");
  if (
    !prefersActivityPub(request.headers.get("Accept"), alternate.mediaType) ||
    alternate.url.href === request.url
  ) {
    return;
  }

  const headers = new Headers({
    Link: responseHeaders.get("Link")!,
    Location: alternate.url.href,
    Vary: responseHeaders.get("Vary")!,
  });
  for (const cookie of responseHeaders.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 307, headers });
}

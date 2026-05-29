import type { RouteDefinition } from "@solidjs/router";
import type { APIEvent } from "@solidjs/start/server";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import type { IEnvironment } from "relay-runtime";
import { fetchQuery, graphql } from "relay-runtime";
import { createEnvironment } from "../../../../../RelayEnvironment.tsx";
import type { ogimageLanguageQuery } from "./__generated__/ogimageLanguageQuery.graphql.ts";
import type { ogimageQuery } from "./__generated__/ogimageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

export async function GET({ params, request }: APIEvent) {
  const { handle: rawHandle, idOrYear, slug: rawSlug } = params;
  if (!rawHandle || !idOrYear || !rawSlug) {
    return new Response("Not Found", { status: 404 });
  }
  // SolidStart does not decode route params, so non-ASCII handles/slugs arrive
  // percent-encoded; decode them to match stored values (`idOrYear` is numeric).
  const handle = decodeRouteParam(rawHandle);
  const slug = decodeRouteParam(rawSlug);

  const requestUrl = new URL(request.url);
  const environment = createEnvironment();
  const requestedLanguage = requestUrl.searchParams.get("l")?.trim();
  const language = requestedLanguage ||
    await getDefaultLanguage(environment, handle, idOrYear, slug);
  if (language == null) {
    return new Response("Not Found", { status: 404 });
  }

  const response = await fetchQuery<ogimageQuery>(
    environment,
    graphql`
      query ogimageQuery(
        $handle: String!
        $idOrYear: String!
        $slug: String!
        $language: Locale
      ) {
        articleByYearAndSlug(
          handle: $handle
          idOrYear: $idOrYear
          slug: $slug
        ) {
          contents(language: $language) {
            ogImageUrl
          }
        }
      }
    `,
    { handle, idOrYear, slug, language },
  ).toPromise();

  const ogImageUrl = response?.articleByYearAndSlug?.contents[0]?.ogImageUrl;
  if (ogImageUrl == null) {
    return new Response("Not Found", { status: 404 });
  }

  return Response.redirect(ogImageUrl, 302);
}

async function getDefaultLanguage(
  environment: IEnvironment,
  handle: string,
  idOrYear: string,
  slug: string,
) {
  const response = await fetchQuery<ogimageLanguageQuery>(
    environment,
    graphql`
      query ogimageLanguageQuery(
        $handle: String!
        $idOrYear: String!
        $slug: String!
      ) {
        articleByYearAndSlug(
          handle: $handle
          idOrYear: $idOrYear
          slug: $slug
        ) {
          language
          contents {
            language
          }
        }
      }
    `,
    { handle, idOrYear, slug },
  ).toPromise();

  const article = response?.articleByYearAndSlug;
  if (article == null) return null;
  const contentLanguages = article.contents.map((content) => content.language);
  return contentLanguages.find((language) => language === article.language) ??
    contentLanguages[0] ?? null;
}

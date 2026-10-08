import type { RouteDefinition } from "@solidjs/router";
import type { APIEvent } from "@solidjs/start/server";
import { fetchQuery, graphql } from "relay-runtime";
import { createEnvironment } from "../../../RelayEnvironment.tsx";
import type { ogQuery } from "~/__generated__/ogQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

export async function GET({ params }: APIEvent) {
  const { handle } = params;
  if (!handle) {
    return new Response("Not Found", { status: 404 });
  }

  const response = await fetchQuery<ogQuery>(
    createEnvironment(),
    graphql`
      query ogQuery($username: String!) {
        accountByUsername(username: $username) {
          ogImageUrl
        }
      }
    `,
    { username: handle.slice(1) },
  ).toPromise();

  const ogImageUrl = response?.accountByUsername?.ogImageUrl;
  if (ogImageUrl == null) {
    return new Response("Not Found", { status: 404 });
  }

  return Response.redirect(ogImageUrl, 302);
}

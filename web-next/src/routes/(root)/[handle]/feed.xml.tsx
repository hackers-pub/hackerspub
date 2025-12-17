import { stripHtml } from "@hackerspub/models/html";
import { Feed } from "feed";
import { fetchQuery, graphql } from "relay-runtime";
import type { APIEvent } from "@solidjs/start/server";
import type { RouteDefinition } from "@solidjs/router";
import { createEnvironment } from "../../../RelayEnvironment.tsx";
import type { feed_Query } from "./__generated__/feed_Query.graphql.ts";
import { CANONICAL_ORIGIN_URL } from "~/lib/env.ts";

const WINDOW = 50;

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

export async function GET({ params, request }: APIEvent) {
  const { handle } = params;
  const requestUrl = new URL(request.url);
  const requestSearchParams = requestUrl.searchParams;

  if (!handle) {
    return new Response("Not Found", { status: 404 });
  }

  const username = handle.slice(1);

  const response = await fetchQuery<feed_Query>(
    createEnvironment(),
    graphql`
      query feed_Query($username: String!, $limit: Int!) {
        accountByUsername(username: $username) {
          id
          name
          avatarUrl
          updated
          actor {
            bio
            posts(first: $limit) {
              edges {
                node {
                  __typename
                  id
                  updated
                  published
                  iri
                  url
                  name
                  visibility
                  content
                  summary
                  media {
                    url
                    alt
                    type
                  }
                }
              }
            }
          }
        }
      }
    `,
    { username, limit: WINDOW },
  ).toPromise();

  const account = response?.accountByUsername;
  if (!account) {
    return new Response("Not Found", { status: 404 });
  }

  const articlesOnly = requestSearchParams.has("articles");

  const canonicalUrl = new URL(
    `/@${username}/feed.xml${articlesOnly ? "?articles" : ""}`,
    CANONICAL_ORIGIN_URL,
  );
  const profileUrl = new URL(
    `/@${username}${articlesOnly ? "/articles" : ""}`,
    CANONICAL_ORIGIN_URL,
  );
  const avatarUrl = account.avatarUrl;

  const posts = account.actor.posts.edges.map((edge) => edge.node).filter((
    post,
  ) =>
    (post.visibility === "PUBLIC" || post.visibility === "UNLISTED") &&
    (!articlesOnly || post.__typename === "Article")
  );

  const feed = new Feed({
    id: canonicalUrl.toString(),
    link: profileUrl.toString(),
    title: account.name,
    description: account.actor.bio == null
      ? undefined
      : stripHtml(account.actor.bio),
    generator: "Hackers' Pub",
    image: avatarUrl,
    favicon: avatarUrl,
    updated: posts.length > 0
      ? new Date(posts[0].updated)
      : new Date(account.updated),
    copyright: account.name,
    feedLinks: {
      atom: canonicalUrl.toString(),
    },
    author: {
      name: account.name,
      link: profileUrl.toString(),
    },
  });
  for (const post of posts) {
    feed.addItem({
      id: post.iri,
      link: post.url ?? post.iri,
      title: post.name ?? stripHtml(post.content),
      description: post.summary ?? undefined,
      content: post.content,
      author: [
        {
          name: account.name,
          link: profileUrl.toString(),
        },
      ],
      date: new Date(post.updated),
      published: new Date(post.published),
      image: post.media.length > 0
        ? {
          url: post.media[0].url,
          title: post.media[0].alt ?? undefined,
          type: post.media[0].type ?? undefined,
        }
        : undefined,
    });
  }

  return new Response(feed.atom1(), {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
    },
  });
}

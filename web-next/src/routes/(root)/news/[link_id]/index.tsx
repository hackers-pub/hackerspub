import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Title } from "@solidjs/meta";
import { useLocation, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NewsDiscussion } from "~/components/NewsDiscussion.tsx";
import { NewsStoryHeader } from "~/components/NewsStoryHeader.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { LinkIdPageQuery } from "./__generated__/LinkIdPageQuery.graphql.ts";

const LinkIdPageQuery = graphql`
  query LinkIdPageQuery($id: UUID!) {
    newsStory(id: $id) {
      title
      ...NewsStoryHeader_story
      ...NewsDiscussion_story
    }
  }
`;

const loadLinkIdPageQuery = routePreloadedQuery(
  (id: Uuid) =>
    loadQuery<LinkIdPageQuery>(useRelayEnvironment()(), LinkIdPageQuery, {
      id,
    }),
  "loadLinkIdPageQuery",
);

export default function NewsDiscussionPage() {
  const { t } = useLingui();
  const params = useParams();
  const location = useLocation();

  // Resolve the `#post-<uuid>` fragment so the thread can auto-expand to it.
  const targetUuid = createMemo(() => {
    const m = /^#post-([0-9a-f-]+)$/i.exec(location.hash);
    return m?.[1] ?? null;
  });

  return (
    <NarrowContainer>
      <Show
        when={validateUuid(params.link_id!)}
        fallback={<NotFoundPage embedded />}
      >
        <NewsDiscussionContent
          linkId={params.link_id! as Uuid}
          targetUuid={targetUuid()}
          titleFallback={t`Hackers' Pub: News`}
        />
      </Show>
    </NarrowContainer>
  );
}

function NewsDiscussionContent(props: {
  linkId: Uuid;
  targetUuid: string | null;
  titleFallback: string;
}) {
  const data = createStablePreloadedQuery<LinkIdPageQuery>(
    LinkIdPageQuery,
    () => loadLinkIdPageQuery(props.linkId),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show keyed when={data.newsStory} fallback={<NotFoundPage embedded />}>
          {(story) => (
            <>
              <Title>
                {story.title
                  ? `Hackers' Pub: ${story.title}`
                  : props.titleFallback}
              </Title>
              <div class="px-4 pt-6">
                <NewsStoryHeader $story={story} />
              </div>
              <NewsDiscussion $story={story} targetUuid={props.targetUuid} />
            </>
          )}
        </Show>
      )}
    </Show>
  );
}

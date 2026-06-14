import { page } from "@fresh/core";
import { extractMentionsFromHtml } from "@hackerspub/models/markup";
import type { Account, Actor } from "@hackerspub/models/schema";
import {
  isProfileHiddenFor,
  redactHiddenProfileActor,
} from "../../censorship.ts";
import { ActorList } from "../../components/ActorList.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

const WINDOW = 23;

export const handler = define.handlers({
  async GET(ctx) {
    const { username } = ctx.params;
    if (username.includes("@")) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      with: { actor: true },
      where: { username },
    });
    if (account == null) return ctx.redirect(`/@${username}`);
    const until = ctx.url.searchParams.get("until");
    const followees = await db.query.followingTable.findMany({
      with: {
        followee: {
          with: { account: true },
        },
      },
      where: {
        followerId: account.actor.id,
        accepted: {
          isNotNull: true,
          ...(
            until == null || !until.match(/^\d+(\.\d+)?$/)
              ? undefined
              : { lt: new Date(parseInt(until)) }
          ),
        },
      },
      orderBy: { accepted: "desc" },
      limit: WINDOW + 1,
    });
    let nextUrl: string | undefined;
    if (followees.length > WINDOW) {
      nextUrl = `?until=${followees[WINDOW - 1].accepted!.getTime()}`;
    }
    // A banned actor in the list is redacted (name, bio, avatar, header,
    // fields) for non-moderator viewers before mentions are extracted from
    // bios and before the list is rendered, so the following list does not
    // leak banned profiles' content.
    const visibleFollowees = followees.slice(0, WINDOW).map((f) =>
      isProfileHiddenFor(f.followee, ctx.state.account)
        ? redactHiddenProfileActor(f.followee)
        : f.followee
    );
    const followeesMentions = await extractMentionsFromHtml(
      ctx.state.fedCtx,
      visibleFollowees.map((f) => f.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(account),
        kv,
      },
    );
    // A banned profile's display name is redacted to the username.
    const profileName = isProfileHiddenFor(account.actor, ctx.state.account)
      ? account.username
      : account.name;
    ctx.state.title = ctx.state.t("profile.followeeList.title", {
      name: profileName,
    });
    return page<FolloweeListProps>({
      account: { ...account, name: profileName },
      followees: visibleFollowees,
      followeesMentions,
      nextUrl,
    });
  },
});

interface FolloweeListProps {
  account: Account;
  followees: (Actor & { account?: Account | null })[];
  followeesMentions: { actor: Actor }[];
  nextUrl?: string;
}

export default define.page<typeof handler, FolloweeListProps>(
  function FolloweeList({ data, state }) {
    return (
      <>
        <PageTitle>
          <Msg
            $key="profile.followeeList.title"
            name={
              <a href={`/@${data.account.username}`} rel="top">
                {data.account.name}
              </a>
            }
          />
        </PageTitle>
        <ActorList
          canonicalOrigin={state.canonicalOrigin}
          actors={data.followees}
          actorMentions={data.followeesMentions}
          nextUrl={data.nextUrl}
        />
      </>
    );
  },
);

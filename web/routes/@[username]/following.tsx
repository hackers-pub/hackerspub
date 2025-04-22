import { page } from "@fresh/core";
import { extractMentionsFromHtml } from "@hackerspub/models/markup";
import type { Account, Actor } from "@hackerspub/models/schema";
import { ActorList } from "../../components/ActorList.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
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
    const disk = drive.use();
    const followeesMentions = await extractMentionsFromHtml(
      db,
      disk,
      ctx.state.fedCtx,
      followees.slice(0, WINDOW).map((f) => f.followee.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(account),
        kv,
      },
    );
    ctx.state.title = ctx.state.t("profile.followeeList.title", {
      name: account.name,
    });
    return page<FolloweeListProps>({
      account,
      followees: followees.map((f) => f.followee).slice(0, WINDOW),
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
  function FolloweeList({ data }) {
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
          actors={data.followees}
          actorMentions={data.followeesMentions}
          nextUrl={data.nextUrl}
        />
      </>
    );
  },
);

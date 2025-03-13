import { and, desc, eq, isNotNull } from "drizzle-orm";
import { page } from "fresh";
import { ActorList } from "../../components/ActorList.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { extractMentionsFromHtml } from "../../models/markup.ts";
import {
  type Account,
  accountTable,
  type Actor,
  followingTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const { username } = ctx.params;
    if (username.includes("@")) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      with: { actor: true },
      where: eq(accountTable.username, username),
    });
    if (account == null) return ctx.redirect(`/@${username}`);
    const followees = await db.query.followingTable.findMany({
      with: {
        followee: {
          with: { account: true },
        },
      },
      where: and(
        eq(followingTable.followerId, account.actor.id),
        isNotNull(followingTable.accepted),
      ),
      orderBy: desc(followingTable.accepted),
    });
    const followeesMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      followees.map((f) => f.followee.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(account),
      },
    );
    ctx.state.title = ctx.state.t("profile.followeeList.title", {
      name: account.name,
    });
    return page<FolloweeListProps>({
      account,
      followees: followees.map((f) => f.followee),
      followeesMentions,
    });
  },
});

interface FolloweeListProps {
  account: Account;
  followees: (Actor & { account?: Account | null })[];
  followeesMentions: { actor: Actor }[];
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
        />
      </>
    );
  },
);

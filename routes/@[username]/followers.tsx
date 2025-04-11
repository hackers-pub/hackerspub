import { page } from "fresh";
import { ActorList } from "../../components/ActorList.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import { ConfirmForm } from "../../islands/ConfirmForm.tsx";
import { kv } from "../../kv.ts";
import { removeFollower } from "../../models/following.ts";
import { extractMentionsFromHtml } from "../../models/markup.ts";
import type { Account, Actor } from "../../models/schema.ts";
import { validateUuid } from "../../models/uuid.ts";
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
    const followers = await db.query.followingTable.findMany({
      with: {
        follower: {
          with: { account: true },
        },
      },
      where: {
        followeeId: account.actor.id,
        accepted: {
          isNotNull: true,
          ...(until == null || !until.match(/^\d+(\.\d+)?$/)
            ? undefined
            : { lt: new Date(parseInt(until)) }),
        },
      },
      orderBy: { accepted: "desc" },
      limit: WINDOW + 1,
    });
    let nextUrl: string | undefined;
    if (followers.length > WINDOW) {
      nextUrl = `?until=${followers[WINDOW - 1].accepted!.getTime()}`;
    }
    const followersMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      followers.slice(0, WINDOW).map((f) => f.follower.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(account),
        kv,
      },
    );
    ctx.state.title = ctx.state.t("profile.followerList.title", {
      name: account.name,
    });
    return page<FollowerListProps>({
      account,
      followers: followers.map((f) => f.follower).slice(0, WINDOW),
      followersMentions,
      nextUrl,
    });
  },

  async POST(ctx) {
    const { username } = ctx.params;
    if (username.includes("@")) return ctx.next();
    if (ctx.state.account?.username !== username) return ctx.next();
    const form = await ctx.req.formData();
    const followerId = form.get("followerId");
    if (!validateUuid(followerId)) return ctx.next();
    const follower = await db.query.actorTable.findFirst({
      where: { id: followerId },
    });
    if (follower == null) return ctx.next();
    await removeFollower(db, ctx.state.fedCtx, ctx.state.account, follower);
    const returnUrl = form.get("return")?.toString();
    return ctx.redirect(returnUrl ?? `/@${username}/followers`);
  },
});

interface FollowerListProps {
  account: Account;
  followers: (Actor & { account?: Account | null })[];
  followersMentions: { actor: Actor }[];
  nextUrl?: string;
}

export default define.page<typeof handler, FollowerListProps>(
  function FollowerList({ data, state: { t, account } }) {
    return (
      <>
        <PageTitle>
          <Msg
            $key="profile.followerList.title"
            name={
              <a href={`/@${data.account.username}`} rel="top">
                {data.account.name}
              </a>
            }
          />
        </PageTitle>
        <ActorList
          actors={data.followers}
          actorMentions={data.followersMentions}
          nextUrl={data.nextUrl}
          rightTopButton={account == null || account.id !== data.account.id
            ? undefined
            : (actor) => (
              <ConfirmForm
                method="post"
                confirm={t("profile.followerList.removeConfirm", {
                  name: actor.name ?? actor.username,
                  handle: actor.handle,
                })}
              >
                <button
                  type="submit"
                  name="followerId"
                  value={actor.id}
                  class="size-6"
                  title={t("profile.followerList.remove")}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="size-6 stroke-stone-400 hover:stroke-stone-800 dark:stroke-stone-500 dark:hover:stroke-stone-100 hover:stroke-2"
                    aria-label={t("profile.followerList.remove")}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18 18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </ConfirmForm>
            )}
        />
      </>
    );
  },
);

import { page } from "@fresh/core";
import { getAvatarUrl } from "@hackerspub/models/actor";
import {
  type Account,
  accountTable,
  type Actor,
} from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { Button } from "../components/Button.tsx";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { db } from "../db.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET() {
    const accounts = await db.query.accountTable.findMany({
      with: { actor: true },
    });
    const tree: Tree = new Map();
    for (const account of accounts) {
      const set = tree.get(account.inviterId);
      if (set == null) {
        tree.set(account.inviterId, new Set([account]));
      } else {
        set.add(account);
      }
    }
    return page<TreePageProps>({ tree });
  },

  async POST(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const form = await ctx.req.formData();
    const hideFromInvitationTree =
      form.get("hideFromInvitationTree") === "true";
    await db.update(accountTable)
      .set({ hideFromInvitationTree })
      .where(eq(accountTable.id, ctx.state.account.id));
    return ctx.redirect("/tree", 303);
  },
});

type Tree = Map<Uuid | null, Set<Account & { actor: Actor }>>;

interface LeafProps {
  tree: Tree;
  parentId: Uuid | null;
  class?: string;
}

function Leaf({ tree, parentId, class: cls }: LeafProps) {
  const children = tree.get(parentId) ?? new Set();
  const list = [...children];
  list.sort((a, b) => +a.created - +b.created);
  return (
    <ul class={cls}>
      {list.map((account) => (
        <li
          key={account.id}
          class="
            pt-4
            pl-7 border-l border-l-stone-600 last:border-l-0
            last:before:content-['.'] last:before:absolute last:before:text-transparent
            last:before:border-l last:before:border-l-stone-600
            last:before:h-12 last:before:ml-[-1.75rem] last:before:mt-[-1rem]
          "
        >
          <div class="
            flex items-center gap-2
            before:content-['.'] before:absolute before:text-transparent
            before:border-t before:border-t-stone-600
            before:w-7 before:mt-7 before:ml-[-1.75rem]
          ">
            {account.hideFromInvitationTree
              ? (
                <>
                  <img
                    class="shrink-0 size-14"
                    src={getAvatarUrl({ avatarUrl: null })}
                  />
                  <div class="flex flex-col">
                    <strong>
                      <Msg $key="invitationTree.hiddenAccount" />
                    </strong>
                    <span class="text-stone-500 dark:text-stone-400">
                      <Msg $key="invitationTree.hiddenAccountDescription" />
                    </span>
                  </div>
                </>
              )
              : (
                <>
                  <a href={`/@${account.username}`} class="shrink-0">
                    <img
                      class="size-14"
                      src={getAvatarUrl(account.actor)}
                    />
                  </a>
                  <div class="flex flex-col">
                    <a href={`/@${account.username}`} class="font-bold">
                      {account.name}
                    </a>
                    <span class="text-stone-500 dark:text-stone-400">
                      <a href={`/@${account.username}`}>
                        @{account.username}@{account.actor.handleHost}
                      </a>{" "}
                      &middot;{" "}
                      <Msg
                        $key="invitationTree.invited"
                        count={tree.get(account.id)?.size ?? 0}
                      />
                    </span>
                  </div>
                </>
              )}
          </div>
          {tree.get(account.id) != null &&
            (
              <Leaf
                tree={tree}
                parentId={account.id}
                class="ml-7"
              />
            )}
        </li>
      ))}
    </ul>
  );
}

interface TreePageProps {
  tree: Tree;
}

export default define.page<typeof handler, TreePageProps>(
  function TreePage({ state: { account }, data: { tree } }) {
    return (
      <form method="post">
        <PageTitle>
          <Msg $key="invitationTree.title" />
        </PageTitle>
        {account != null &&
          (
            <Button
              type="submit"
              name="hideFromInvitationTree"
              value={account.hideFromInvitationTree ? "false" : "true"}
            >
              <Msg
                $key={account.hideFromInvitationTree
                  ? "invitationTree.showMe"
                  : "invitationTree.hideMe"}
              />
            </Button>
          )}
        <Leaf tree={tree} parentId={null} class="mt-4" />
      </form>
    );
  },
);

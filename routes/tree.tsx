import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { db } from "../db.ts";
import { getAvatarUrl } from "../models/actor.ts";
import type { Account, Actor } from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { define } from "../utils.ts";

export const handler = define.handlers(async (ctx) => {
  if (ctx.state.account == null) return ctx.next();
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
            <img
              class="size-14"
              src={getAvatarUrl(account.actor)}
              alt={account.username}
            />
            <div class="flex flex-col">
              <a href={`/@${account.username}`} class="font-bold">
                {account.name}
              </a>
              <a
                href={`/@${account.username}`}
                class="text-stone-500 dark:text-stone-400"
              >
                @{account.username}@{account.actor.handleHost}
              </a>
            </div>
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
  function TreePage({ data: { tree } }) {
    return (
      <div>
        <PageTitle>
          <Msg $key="invitationTree.title" />
        </PageTitle>
        <Leaf tree={tree} parentId={null} />
      </div>
    );
  },
);

import * as vocab from "@fedify/fedify/vocab";
import { and, eq, inArray } from "drizzle-orm";
import { page } from "fresh";
import { NoteExcerpt } from "../../../components/NoteExcerpt.tsx";
import { db } from "../../../db.ts";
import { getAvatarUrl } from "../../../models/account.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import {
  type Account,
  accountTable,
  type NoteSource,
  noteSourceTable,
} from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.idOrYear)) return ctx.next();
    const id = ctx.params.idOrYear;
    const note = await db.query.noteSourceTable.findFirst({
      with: {
        account: {
          with: { emails: true, links: true },
        },
        post: {
          with: {
            actor: {
              with: { followers: true },
            },
            mentions: true,
          },
        },
      },
      where: and(
        eq(noteSourceTable.id, id),
        inArray(
          noteSourceTable.accountId,
          db.select({ id: accountTable.id })
            .from(accountTable)
            .where(eq(accountTable.username, ctx.params.username)),
        ),
      ),
    });
    if (note == null) return ctx.next();
    if (!isPostVisibleTo(note.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const noteUri = ctx.state.fedCtx.getObjectUri(vocab.Note, { id: note.id });
    ctx.state.links.push(
      {
        rel: "canonical",
        href: new URL(`/@${note.account.username}/${note.id}`, ctx.url),
      },
      {
        rel: "alternate",
        type: "application/activity+json",
        href: noteUri,
      },
    );
    return page<NotePageProps>({
      note,
      avatarUrl: await getAvatarUrl(note.account),
      contentHtml:
        (await renderMarkup(db, ctx.state.fedCtx, note.id, note.content)).html,
    }, {
      headers: {
        Link:
          `<${noteUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },
});

interface NotePageProps {
  note: NoteSource & { account: Account };
  avatarUrl: string;
  contentHtml: string;
}

export default define.page<typeof handler, NotePageProps>(
  function NotePage({ url, data: { note, avatarUrl, contentHtml } }) {
    return (
      <NoteExcerpt
        url={`/@${note.account.username}/${note.id}`}
        contentHtml={contentHtml}
        lang={note.language}
        visibility={note.visibility}
        authorUrl={`/@${note.account.username}`}
        authorName={note.account.name}
        authorHandle={`@${note.account.username}@${url.host}`}
        authorAvatarUrl={avatarUrl}
        published={note.published}
      />
    );
  },
);

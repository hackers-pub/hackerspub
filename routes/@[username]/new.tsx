import { eq } from "drizzle-orm";
import { page } from "fresh";
import { db } from "../../db.ts";
import { Editor } from "../../islands/Editor.tsx";
import { accountTable } from "../../models/schema.ts";
import { generateUuidV7, Uuid } from "../../models/uuid.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.id, ctx.state.session.accountId),
    });
    if (account == null || account.username != ctx.params.username) {
      return ctx.next();
    }
    ctx.state.withoutMain = true;
    return page<NewPostPageProps>({
      draftId: generateUuidV7(),
    });
  },
});

interface NewPostPageProps {
  draftId: Uuid;
}

export default define.page<typeof handler, NewPostPageProps>(
  function NewPostPage({ params, data: { draftId } }) {
    return (
      <main class="w-full h-[calc(100vh-3.75rem)]">
        <Editor
          class="w-full h-full"
          previewUrl="/api/preview"
          draftUrl={`/@${params.username}/drafts/${draftId}`}
        />
      </main>
    );
  },
);

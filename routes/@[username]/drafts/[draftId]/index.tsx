import * as v from "@valibot/valibot";
import { and, eq } from "drizzle-orm";
import { francAll } from "franc";
import { page } from "fresh";
import { iso6393To1 } from "iso-639-3";
import { db } from "../../../../db.ts";
import { updateArticleDraft } from "../../../../models/article.ts";
import { define } from "../../../../utils.ts";
import {
  type Account,
  accountTable,
  articleDraftTable,
} from "../../../../models/schema.ts";
import { validateUuid } from "../../../../models/uuid.ts";
import { Editor } from "../../../../islands/Editor.tsx";
import { getLogger } from "@logtape/logtape";

const logger = getLogger([
  "hackerspub",
  "routes",
  "@[username]",
  "drafts",
  "[draftId]",
]);

const TagSchema = v.pipe(v.string(), v.regex(/^[^\s,]+$/));

const ArticleDraftSchema = v.object({
  title: v.pipe(v.optional(v.string(), ""), v.trim()),
  content: v.optional(v.string(), ""),
  tags: v.optional(v.array(TagSchema), []),
});

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.id, ctx.state.session.accountId),
    });
    if (account == null || account.username != ctx.params.username) {
      return ctx.next();
    }
    const draft = await db.query.articleDraftTable.findFirst({
      where: and(
        eq(articleDraftTable.id, ctx.params.draftId),
        eq(articleDraftTable.accountId, account.id),
      ),
    });
    ctx.state.withoutMain = true;
    return page<DraftPageProps>({
      account,
      ...draft ?? {
        title: "",
        content: "",
        tags: [],
      },
    });
  },

  async PUT(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    const data = await ctx.req.json();
    const result = v.safeParse(ArticleDraftSchema, data);
    if (!result.success) {
      return new Response(
        JSON.stringify(result.issues),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const draft = await updateArticleDraft(db, {
      ...result.output,
      id: ctx.params.draftId,
      accountId: ctx.state.session.accountId,
    });
    const acceptLanguages = parseAcceptLanguage(
      ctx.req.headers.get("Accept-Language") ?? "",
    );
    const langDetect = francAll(draft.title + "\n\n" + draft.content);
    for (let i = 0; i < langDetect.length; i++) {
      langDetect[i][0] = iso6393To1[langDetect[i][0]] ?? langDetect[i][0];
      langDetect[i][1] = (langDetect[i][1] +
        (acceptLanguages[langDetect[i][0]] ?? acceptLanguages["*"] ?? 0)) / 2;
    }
    langDetect.sort((a, b) => b[1] - a[1]);
    logger.debug("Detected languages: {languages}", { languages: langDetect });
    const detectedLang = langDetect[0][0];
    const language = detectedLang ?? null;
    logger.debug("Detected language: {language}", { language });
    return new Response(
      JSON.stringify({
        ...draft,
        language,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

interface DraftPageProps {
  account: Account;
  title: string;
  content: string;
  tags: string[];
}

export default define.page<typeof handler, DraftPageProps>(
  function DraftPage({ url, data }) {
    return (
      <main class="w-full h-[calc(100vh-3.75rem)]">
        <Editor
          class="w-full h-full"
          previewUrl={new URL("/api/preview", url).href}
          draftUrl={url.href}
          publishUrl={`${url.href}/publish`}
          publishUrlPrefix={new URL(`/@${data.account.username}/`, url).href}
          defaultTitle={data.title}
          defaultContent={data.content}
          defaultTags={data.tags}
        />
      </main>
    );
  },
);

function parseAcceptLanguage(acceptLanguage: string): Record<string, number> {
  const langs: [string, number][] = acceptLanguage.split(",").map((lang) => {
    const [code, q] = lang.trim().split(";").map((s) => s.trim());
    return [code.substring(0, 2), q == null ? 1 : parseFloat(q.split("=")[1])];
  });
  langs.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(langs);
}

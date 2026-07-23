import { assertStringIncludes } from "@std/assert";

Deno.test("QuestionCardContent intercepts backend-tagged content links", async () => {
  const source = await Deno.readTextFile(
    new URL("./QuestionCard.tsx", import.meta.url),
  );
  const contentStart = source.indexOf("function QuestionCardContent");
  const contentEnd = source.indexOf("\n  function PollPanel", contentStart);
  const questionContent = source.slice(contentStart, contentEnd);

  assertStringIncludes(questionContent, "ref={setProseRef}");
  assertStringIncludes(questionContent, "innerHTML={q.content}");
  assertStringIncludes(
    questionContent,
    "useContentLinkInterceptor(proseRef);",
  );
});

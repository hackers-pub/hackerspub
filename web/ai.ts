import type { createAiModels } from "@hackerspub/runtime/resources";

type AiModels = ReturnType<typeof createAiModels>;

export let altTextGenerator: AiModels["altTextGenerator"];
export let summarizer: AiModels["summarizer"];
export let translator: AiModels["translator"];
export let moderationAnalyzer: AiModels["moderationAnalyzer"];

export function configureAiModels(models: AiModels): void {
  altTextGenerator = models.altTextGenerator;
  summarizer = models.summarizer;
  translator = models.translator;
  moderationAnalyzer = models.moderationAnalyzer;
}

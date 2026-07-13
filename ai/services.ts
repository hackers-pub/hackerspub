import type { AiServices } from "@hackerspub/models/services";
import type { LanguageModel } from "ai";
import { analyzeFlaggedContent } from "./moderation.ts";
import { summarize } from "./summary.ts";
import { translate } from "./translate.ts";

function unwrapModel(
  model: { readonly implementation: unknown },
): LanguageModel {
  return model != null && "implementation" in model
    ? model.implementation as LanguageModel
    : model as unknown as LanguageModel;
}

export const aiServices: AiServices = {
  analyzeFlaggedContent: (options) =>
    analyzeFlaggedContent({
      ...options,
      model: unwrapModel(options.model),
    }),
  summarize: (options) =>
    summarize({
      ...options,
      model: unwrapModel(options.model),
    }),
  translate: (options) =>
    translate({
      ...options,
      model: unwrapModel(options.model),
      summarizationModel: options.summarizationModel == null
        ? undefined
        : unwrapModel(options.summarizationModel),
    }),
};

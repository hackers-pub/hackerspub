import type { AiServices } from "@hackerspub/models/services";
import { analyzeFlaggedContent } from "./moderation.ts";
import { summarize } from "./summary.ts";
import { translate } from "./translate.ts";

export const aiServices: AiServices = {
  analyzeFlaggedContent,
  summarize,
  translate,
};

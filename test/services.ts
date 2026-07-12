import type { Context } from "@fedify/fedify";
import { aiServices } from "@hackerspub/ai/services";
import { federationServices } from "@hackerspub/federation/services";
import type { ContextData } from "@hackerspub/models/context";
import type { ApplicationServices } from "@hackerspub/models/services";

export const services = {
  ai: aiServices,
  federation: federationServices,
} satisfies ApplicationServices<Context<ContextData>>;

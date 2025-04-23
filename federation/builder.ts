import {
  createFederationBuilder,
  type FederationBuilder,
} from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";

export const builder: FederationBuilder<ContextData> = createFederationBuilder<
  ContextData
>();

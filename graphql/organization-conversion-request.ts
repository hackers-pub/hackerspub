import type { OrganizationConversionRequest } from "@hackerspub/models/schema";
import { builder } from "./builder.ts";

export const OrganizationConversionRequestRef =
  builder.objectRef<OrganizationConversionRequest>(
    "OrganizationConversionRequest",
  );

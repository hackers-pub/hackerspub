import type { OrganizationMembership } from "@hackerspub/models/schema";
import { builder } from "./builder.ts";

export const OrganizationMembershipRef = builder.objectRef<
  OrganizationMembership
>("OrganizationMembership");

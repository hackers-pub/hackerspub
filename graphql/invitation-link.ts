import {
  accountTable,
  invitationLinkTable,
  type NewInvitationLink,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";

const logger = getLogger(["hackerspub", "graphql", "invitation-link"]);

export const InvitationLink = builder.drizzleNode("invitationLinkTable", {
  name: "InvitationLink",
  id: {
    column: (link) => link.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    inviter: t.relation("inviter", { type: Account }),
    invitationsLeft: t.exposeInt("invitationsLeft"),
    message: t.expose("message", { type: "Markdown", nullable: true }),
    created: t.expose("created", { type: "DateTime" }),
    expires: t.expose("expires", { type: "DateTime", nullable: true }),
    url: t.field({
      type: "URL",
      select: {
        columns: { id: true },
        with: {
          inviter: { columns: { username: true } },
        },
      },
      resolve(link, _, ctx) {
        return new URL(
          `/@${link.inviter.username}/invite/${link.id}`,
          ctx.fedCtx.canonicalOrigin,
        );
      },
    }),
  }),
});

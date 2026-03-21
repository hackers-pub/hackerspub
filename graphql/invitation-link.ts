import { toDate } from "@hackerspub/models/date";
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
import { InvalidInputError } from "./error.ts";
import { NotAuthenticatedError } from "./session.ts";

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

builder.queryField("invitationLink", (t) =>
  t.drizzleField({
    type: InvitationLink,
    nullable: true,
    args: {
      id: t.arg({ type: "UUID", required: true }),
    },
    resolve(query, _, args, ctx) {
      return ctx.db.query.invitationLinkTable.findFirst(
        query({ where: { id: args.id } }),
      );
    },
  }));

const VALID_EXPIRE_UNITS = ["hours", "days", "weeks", "months"] as const;

function parseExpires(expires: string | null | undefined): Date | null {
  if (expires == null || expires.trim() === "") return null;
  const [valueRaw, unitRaw] = expires.trim().split(/\s+/);
  const value = Number(valueRaw);
  const unit = unitRaw ?? "hours";
  if (
    !Number.isInteger(value) || value <= 0 ||
    !VALID_EXPIRE_UNITS.includes(unit as typeof VALID_EXPIRE_UNITS[number])
  ) {
    throw new InvalidInputError("expires");
  }
  const duration = Temporal.Duration.from(
    unit === "hours"
      ? { hours: value }
      : unit === "days"
      ? { days: value }
      : unit === "weeks"
      ? { weeks: value }
      : { months: value },
  );
  const now = Temporal.Now.instant();
  const zoned = now.toZonedDateTimeISO(Temporal.Now.timeZoneId());
  return toDate(zoned.add(duration).toInstant())!;
}

builder.mutationField("createInvitationLink", (t) =>
  t.field({
    type: InvitationLink,
    errors: {
      types: [NotAuthenticatedError, InvalidInputError],
      union: { name: "CreateInvitationLinkResult" },
      result: { name: "CreateInvitationLinkSuccess" },
    },
    args: {
      invitationsLeft: t.arg.int({ required: true }),
      message: t.arg({ type: "Markdown" }),
      expires: t.arg.string(),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      if (args.invitationsLeft <= 0) {
        throw new InvalidInputError("invitationsLeft");
      }
      if (args.invitationsLeft > ctx.account.leftInvitations) {
        throw new InvalidInputError("invitationsLeft");
      }
      const expiresDate = parseExpires(args.expires);
      const id = generateUuidV7();
      await ctx.db.transaction(async (tx) => {
        const [{ leftInvitations }] = await tx.update(accountTable)
          .set({
            leftInvitations:
              sql`${accountTable.leftInvitations} - ${args.invitationsLeft}`,
          })
          .where(eq(accountTable.id, ctx.account!.id))
          .returning();
        if (leftInvitations < 0) {
          throw new Error("Not enough invitations left.");
        }
        await tx.insert(invitationLinkTable).values({
          id,
          inviterId: ctx.account!.id,
          invitationsLeft: args.invitationsLeft,
          message: args.message?.trim() === "" ? null : (args.message ?? null),
          expires: expiresDate,
        } satisfies NewInvitationLink);
      });
      const link = await ctx.db.query.invitationLinkTable.findFirst({
        where: { id },
        with: { inviter: true },
      });
      return link!;
    },
  }));

import { toDate } from "@hackerspub/models/date";
import {
  accountTable,
  invitationLinkTable,
  type NewInvitationLink,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.account?.username !== ctx.params.username) return ctx.next();
    const { account } = ctx.state;
    const form = await ctx.req.formData();
    const message = form.get("message")?.toString();
    const invitationsLeft = parseInt(
      form.get("invitationsLeft")?.toString() ?? "0",
    );
    if (
      !Number.isInteger(invitationsLeft) || invitationsLeft <= 0 ||
      invitationsLeft > account.leftInvitations
    ) {
      return ctx.next();
    }
    const expires = form.get("expires")?.toString();
    let expiresIn: Temporal.Instant | null;
    if (expires == null || expires.trim() === "") {
      expiresIn = null;
    } else {
      const expiresValue = parseInt(expires.split(/\s+/)[0]);
      const expiresUnit = expires.split(/\s+/)[1] ?? "hours";
      const expiresDuration = Temporal.Duration.from(
        expiresUnit === "hours"
          ? { hours: expiresValue }
          : expiresUnit === "days"
          ? { days: expiresValue }
          : expiresUnit === "weeks"
          ? { weeks: expiresValue }
          : expiresUnit === "months"
          ? { months: expiresValue }
          : { hours: 0 },
      );
      if (expiresDuration.total("hours") <= 0) return ctx.next();
      expiresIn = Temporal.Now.instant().add(expiresDuration);
    }
    await db.transaction(async (tx) => {
      const [{ leftInvitations }] = await tx.update(accountTable)
        .set({
          leftInvitations:
            sql`${accountTable.leftInvitations} - ${invitationsLeft}`,
        })
        .where(eq(accountTable.id, account.id))
        .returning();
      if (leftInvitations < 0) {
        throw new Error("Not enough invitations left.");
      }
      await tx.insert(invitationLinkTable).values(
        {
          id: generateUuidV7(),
          inviterId: account.id,
          invitationsLeft,
          message: message?.trim() === "" ? null : message,
          expires: toDate(expiresIn),
        } satisfies NewInvitationLink,
      );
    });
    return ctx.redirect(`/@${account.username}/settings/invite`);
  },
});

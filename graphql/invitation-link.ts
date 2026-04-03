import { normalizeEmail } from "@hackerspub/models/account";
import { toDate } from "@hackerspub/models/date";
import {
  accountTable,
  invitationLinkTable,
  type NewInvitationLink,
} from "@hackerspub/models/schema";
import { createSignupToken } from "@hackerspub/models/signup";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { and, eq, gte, sql } from "drizzle-orm";
import { parseTemplate } from "url-template";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { getEmailMessage } from "./email-helpers.ts";
import { InvalidInputError } from "./error.ts";
import { EXPIRATION } from "./invite.ts";
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
      username: t.arg.string({ required: true }),
    },
    async resolve(query, _, args, ctx) {
      const link = await ctx.db.query.invitationLinkTable.findFirst(
        query({
          where: { id: args.id },
          with: { inviter: { columns: { username: true } } },
        }),
      );
      if (link == null) return null;
      if (link.inviter.username !== args.username) return null;
      return link;
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

interface InvitationLinkPayload {
  linkId: Uuid | null;
  accountId: Uuid;
}

const InvitationLinkPayloadRef = builder.objectRef<InvitationLinkPayload>(
  "InvitationLinkPayload",
);

InvitationLinkPayloadRef.implement({
  fields: (t) => ({
    invitationLink: t.field({
      type: InvitationLink,
      nullable: true,
      async resolve(payload, _, ctx) {
        if (payload.linkId == null) return null;
        return await ctx.db.query.invitationLinkTable.findFirst({
          where: { id: payload.linkId },
          with: { inviter: true },
        });
      },
    }),
    account: t.field({
      type: Account,
      async resolve(payload, _, ctx) {
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: payload.accountId },
          with: { actor: true },
        });
        return account!;
      },
    }),
  }),
});

builder.mutationField("createInvitationLink", (t) =>
  t.field({
    type: InvitationLinkPayloadRef,
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
        const updated = await tx.update(accountTable)
          .set({
            leftInvitations:
              sql`${accountTable.leftInvitations} - ${args.invitationsLeft}`,
          })
          .where(
            and(
              eq(accountTable.id, ctx.account!.id),
              gte(accountTable.leftInvitations, args.invitationsLeft),
            ),
          )
          .returning();
        if (updated.length < 1) {
          throw new InvalidInputError("invitationsLeft");
        }
        await tx.insert(invitationLinkTable).values(
          {
            id,
            inviterId: ctx.account!.id,
            invitationsLeft: args.invitationsLeft,
            message: args.message?.trim() === ""
              ? null
              : (args.message ?? null),
            expires: expiresDate,
          } satisfies NewInvitationLink,
        );
      });
      return { linkId: id, accountId: ctx.account.id };
    },
  }));

class InvitationLinkNotFoundError extends Error {
  public constructor() {
    super("Invitation link not found");
  }
}

builder.objectType(InvitationLinkNotFoundError, {
  name: "InvitationLinkNotFoundError",
  fields: (t) => ({
    message: t.string({ resolve: () => "Invitation link not found" }),
  }),
});

builder.mutationField("deleteInvitationLink", (t) =>
  t.field({
    type: InvitationLinkPayloadRef,
    errors: {
      types: [NotAuthenticatedError, InvitationLinkNotFoundError],
      union: { name: "DeleteInvitationLinkResult" },
      result: { name: "DeleteInvitationLinkSuccess" },
    },
    args: {
      id: t.arg({ type: "UUID", required: true }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const link = await ctx.db.query.invitationLinkTable.findFirst({
        where: { id: args.id },
        with: { inviter: true },
      });
      if (link == null || link.inviterId !== ctx.account.id) {
        throw new InvitationLinkNotFoundError();
      }
      await ctx.db.transaction(async (tx) => {
        const deleted = await tx.delete(invitationLinkTable)
          .where(and(
            eq(invitationLinkTable.inviterId, ctx.account!.id),
            eq(invitationLinkTable.id, args.id),
          ))
          .returning();
        if (deleted.length < 1) return;
        await tx.update(accountTable)
          .set({
            leftInvitations:
              sql`${accountTable.leftInvitations} + ${deleted[0].invitationsLeft}`,
          })
          .where(eq(accountTable.id, ctx.account!.id));
      });
      return { linkId: null, accountId: ctx.account.id };
    },
  }));

const RedeemLinkError = builder.enumType("RedeemLinkError", {
  values: ["LINK_NOT_FOUND", "LINK_EXPIRED", "LINK_EXHAUSTED"] as const,
});

const RedeemEmailError = builder.enumType("RedeemEmailError", {
  values: ["EMAIL_INVALID", "EMAIL_ALREADY_TAKEN"] as const,
});

const RedeemVerifyUrlError = builder.enumType("RedeemVerifyUrlError", {
  values: ["VERIFY_URL_NO_TOKEN", "VERIFY_URL_NO_CODE"] as const,
});

interface RedeemSuccess {
  linkId: Uuid;
  email: string;
}

const RedeemSuccessRef = builder.objectRef<RedeemSuccess>(
  "RedeemInvitationLinkSuccess",
);

RedeemSuccessRef.implement({
  fields: (t) => ({
    invitationLink: t.field({
      type: InvitationLink,
      async resolve(result, _, ctx) {
        const link = await ctx.db.query.invitationLinkTable.findFirst({
          where: { id: result.linkId },
          with: { inviter: true },
        });
        return link!;
      },
    }),
    email: t.field({
      type: "Email",
      resolve: (result) => result.email,
    }),
  }),
});

interface RedeemValidationErrors {
  link?: typeof RedeemLinkError.$inferType;
  email?: typeof RedeemEmailError.$inferType;
  verifyUrl?: typeof RedeemVerifyUrlError.$inferType;
  emailOwnerId?: Uuid;
  sendFailed?: boolean;
}

const RedeemValidationErrorsRef = builder.objectRef<RedeemValidationErrors>(
  "RedeemInvitationLinkValidationErrors",
);

RedeemValidationErrorsRef.implement({
  fields: (t) => ({
    link: t.field({
      type: RedeemLinkError,
      nullable: true,
      resolve: (e) => e.link ?? null,
    }),
    email: t.field({
      type: RedeemEmailError,
      nullable: true,
      resolve: (e) => e.email ?? null,
    }),
    verifyUrl: t.field({
      type: RedeemVerifyUrlError,
      nullable: true,
      resolve: (e) => e.verifyUrl ?? null,
    }),
    emailOwner: t.field({
      type: Account,
      nullable: true,
      resolve(e, _, ctx) {
        if (e.emailOwnerId == null) return null;
        return ctx.db.query.accountTable.findFirst({
          where: { id: e.emailOwnerId },
        });
      },
    }),
    sendFailed: t.boolean({
      nullable: true,
      resolve: (e) => e.sendFailed ?? null,
    }),
  }),
});

const RedeemResultRef = builder.unionType("RedeemInvitationLinkResult", {
  types: [RedeemSuccessRef, RedeemValidationErrorsRef],
  resolveType(obj) {
    if ("linkId" in obj) return RedeemSuccessRef;
    return RedeemValidationErrorsRef;
  },
});

builder.mutationField("redeemInvitationLink", (t) =>
  t.field({
    type: RedeemResultRef,
    args: {
      id: t.arg({ type: "UUID", required: true }),
      email: t.arg({ type: "Email", required: true }),
      locale: t.arg({ type: "Locale", required: true }),
      verifyUrl: t.arg({ type: "URITemplate", required: true }),
    },
    async resolve(_root, args, ctx) {
      const errors = {} as RedeemValidationErrors;

      // Validate link
      const link = await ctx.db.query.invitationLinkTable.findFirst({
        with: { inviter: { with: { actor: true } } },
        where: { id: args.id },
      });
      if (link == null) {
        errors.link = "LINK_NOT_FOUND";
      } else if (link.expires && link.expires < new Date()) {
        errors.link = "LINK_EXPIRED";
      } else if (link.invitationsLeft < 1) {
        errors.link = "LINK_EXHAUSTED";
      }

      // Validate email
      let email: string | undefined;
      try {
        email = normalizeEmail(args.email);
      } catch {
        errors.email = "EMAIL_INVALID";
      }
      if (email != null) {
        const existing = await ctx.db.query.accountEmailTable.findFirst({
          where: { email },
        });
        if (existing != null) {
          errors.email = "EMAIL_ALREADY_TAKEN";
          errors.emailOwnerId = existing.accountId;
        }
      }

      // Validate verifyUrl template
      const verifyUrlTemplate = parseTemplate(args.verifyUrl);
      const a = verifyUrlTemplate.expand({
        token: "00000000-0000-0000-0000-000000000000",
        code: "AAAAAA",
      });
      const b = verifyUrlTemplate.expand({
        token: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        code: "AAAAAA",
      });
      if (a === b) errors.verifyUrl = "VERIFY_URL_NO_TOKEN";
      const c = verifyUrlTemplate.expand({
        token: "00000000-0000-0000-0000-000000000000",
        code: "BBBBBB",
      });
      if (a === c) errors.verifyUrl = "VERIFY_URL_NO_CODE";

      if (
        errors.link != null || errors.email != null ||
        errors.verifyUrl != null || link == null || email == null
      ) {
        return errors;
      }

      // Decrement link invitations in transaction
      let exhausted = false;
      try {
        await ctx.db.transaction(async (tx) => {
          const result = await tx.update(invitationLinkTable)
            .set({
              invitationsLeft: sql`${invitationLinkTable.invitationsLeft} - 1`,
            })
            .where(eq(invitationLinkTable.id, link.id))
            .returning();
          if (result.length < 1 || result[0].invitationsLeft < 0) {
            tx.rollback();
          }
        });
      } catch {
        // tx.rollback() throws TransactionRollbackError
        exhausted = true;
      }

      if (exhausted) {
        return { link: "LINK_EXHAUSTED" } satisfies RedeemValidationErrors;
      }

      // Create signup token and send email
      try {
        const token = await createSignupToken(ctx.kv, email, {
          inviterId: link.inviter.id,
          expiration: EXPIRATION,
        });
        const message = await getEmailMessage({
          locale: args.locale,
          inviter: link.inviter,
          verifyUrlTemplate: args.verifyUrl,
          to: email,
          token,
          message: link.message ?? undefined,
          expiration: EXPIRATION,
        });
        const receipt = await ctx.email.send(message);
        if (!receipt.successful) {
          logger.error(
            "Failed to send invitation link email: {errors}",
            { errors: receipt.errorMessages },
          );
          // Credit back on failure
          await ctx.db.update(invitationLinkTable)
            .set({
              invitationsLeft: sql`${invitationLinkTable.invitationsLeft} + 1`,
            })
            .where(eq(invitationLinkTable.id, link.id));
          return { sendFailed: true } satisfies RedeemValidationErrors;
        }
      } catch (error) {
        logger.error(
          "Failed to create token or send invitation email: {error}",
          { error },
        );
        // Credit back on failure
        await ctx.db.update(invitationLinkTable)
          .set({
            invitationsLeft: sql`${invitationLinkTable.invitationsLeft} + 1`,
          })
          .where(eq(invitationLinkTable.id, link.id));
        throw error;
      }

      return { linkId: link.id, email } satisfies RedeemSuccess;
    },
  }));

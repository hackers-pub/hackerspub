import { assertEquals } from "@std/assert/equals";
import { accountTable } from "@hackerspub/models/schema";
import { execute, parse } from "graphql";
import { eq } from "drizzle-orm";
import { schema } from "./mod.ts";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const inviteMutation = parse(`
  mutation Invite(
    $email: Email!
    $locale: Locale!
    $message: Markdown
    $verifyUrl: URITemplate!
  ) {
    invite(
      email: $email
      locale: $locale
      message: $message
      verifyUrl: $verifyUrl
    ) {
      __typename
      ... on Invitation {
        email
        locale
        message
        inviter {
          username
        }
      }
      ... on InviteValidationErrors {
        inviter
        email
        verifyUrl
      }
    }
  }
`);

Deno.test({
  name: "invite validates verify URLs that do not interpolate the token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "invitevalidator",
        name: "Invite Validator",
        email: "invitevalidator@example.com",
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 1 })
        .where(eq(accountTable.id, account.account.id));

      const result = await execute({
        schema,
        document: inviteMutation,
        variableValues: {
          email: "person@example.com",
          locale: "en-US",
          message: null,
          verifyUrl: "http://localhost/sign/up/static?code={code}",
        },
        contextValue: makeUserContext(tx, {
          ...account.account,
          leftInvitations: 1,
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          invite: {
            __typename: string;
            inviter: string | null;
            email: string | null;
            verifyUrl: string | null;
          };
        }).invite,
        {
          __typename: "InviteValidationErrors",
          inviter: null,
          email: null,
          verifyUrl: "VERIFY_URL_NO_TOKEN",
        },
      );
    });
  },
});

Deno.test({
  name: "invite sends email and stores a signup token on success",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv, store } = createTestKv();
      const email = createTestEmailTransport();
      const inviter = await insertAccountWithActor(tx, {
        username: "inviteowner",
        name: "Invite Owner",
        email: "inviteowner@example.com",
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 1 })
        .where(eq(accountTable.id, inviter.account.id));

      const result = await execute({
        schema,
        document: inviteMutation,
        variableValues: {
          email: "invitee@example.com",
          locale: "en-US",
          message: "Join us",
          verifyUrl: "http://localhost/sign/up/{token}?code={code}",
        },
        contextValue: makeUserContext(tx, {
          ...inviter.account,
          leftInvitations: 1,
        }, {
          kv,
          email: email.transport,
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const invitation = (result.data as {
        invite: {
          __typename: string;
          email?: string;
          locale?: string;
          message?: string | null;
          inviter?: { username: string };
        };
      }).invite;
      assertEquals(invitation.__typename, "Invitation");
      assertEquals(invitation.email, "invitee@example.com");
      assertEquals(invitation.locale, "en-US");
      assertEquals(invitation.message, "Join us");
      assertEquals(invitation.inviter?.username, "inviteowner");
      assertEquals(email.messages.length, 1);

      const storedAccount = await tx.query.accountTable.findFirst({
        where: { id: inviter.account.id },
      });
      assertEquals(storedAccount?.leftInvitations, 0);

      const signupEntries = [...store.entries()].filter(([key]) =>
        key.startsWith("signup/")
      );
      assertEquals(signupEntries.length, 1);
      const token = signupEntries[0][1] as {
        email: string;
        inviterId?: string;
      };
      assertEquals(token.email, "invitee@example.com");
      assertEquals(token.inviterId, inviter.account.id);
    });
  },
});

Deno.test({
  name: "invite refunds invitations when email sending fails",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv, store } = createTestKv();
      const inviter = await insertAccountWithActor(tx, {
        username: "invitefailureowner",
        name: "Invite Failure Owner",
        email: "invitefailureowner@example.com",
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 1 })
        .where(eq(accountTable.id, inviter.account.id));

      const failingEmail = {
        send() {
          return Promise.resolve({
            successful: false,
            errorMessages: ["delivery failed"],
          });
        },
        async *sendMany() {
          yield* [];
        },
      };

      const result = await execute({
        schema,
        document: inviteMutation,
        variableValues: {
          email: "failure@example.com",
          locale: "en-US",
          message: null,
          verifyUrl: "http://localhost/sign/up/{token}?code={code}",
        },
        contextValue: makeUserContext(tx, {
          ...inviter.account,
          leftInvitations: 1,
        }, {
          kv,
          email: failingEmail as never,
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          invite: {
            __typename: string;
            inviter: string | null;
            email: string | null;
            verifyUrl: string | null;
          };
        }).invite,
        {
          __typename: "InviteValidationErrors",
          inviter: "INVITER_EMAIL_SEND_FAILED",
          email: null,
          verifyUrl: null,
        },
      );

      const storedAccount = await tx.query.accountTable.findFirst({
        where: { id: inviter.account.id },
      });
      assertEquals(storedAccount?.leftInvitations, 1);
      const signupEntries = [...store.entries()];
      assertEquals(signupEntries.length, 0);
    });
  },
});

import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { accountTable, invitationLinkTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const createInvitationLinkMutation = parse(`
  mutation CreateInvitationLink(
    $invitationsLeft: Int!
    $message: Markdown
    $expires: String
  ) {
    createInvitationLink(
      invitationsLeft: $invitationsLeft
      message: $message
      expires: $expires
    ) {
      __typename
      ... on InvitationLinkPayload {
        account {
          username
        }
        invitationLink {
          uuid
          invitationsLeft
          message
        }
      }
      ... on InvalidInputError {
        inputPath
      }
    }
  }
`);

const deleteInvitationLinkMutation = parse(`
  mutation DeleteInvitationLink($id: UUID!) {
    deleteInvitationLink(id: $id) {
      __typename
      ... on InvitationLinkPayload {
        account {
          username
        }
        invitationLink {
          uuid
        }
      }
      ... on InvitationLinkNotFoundError {
        message
      }
    }
  }
`);

const redeemInvitationLinkMutation = parse(`
  mutation RedeemInvitationLink(
    $id: UUID!
    $email: Email!
    $locale: Locale!
    $verifyUrl: URITemplate!
  ) {
    redeemInvitationLink(
      id: $id
      email: $email
      locale: $locale
      verifyUrl: $verifyUrl
    ) {
      __typename
      ... on RedeemInvitationLinkSuccess {
        email
        invitationLink {
          uuid
        }
      }
      ... on RedeemInvitationLinkValidationErrors {
        link
        email
        verifyUrl
        sendFailed
      }
    }
  }
`);

Deno.test({
  name:
    "createInvitationLink and deleteInvitationLink update invitation balances",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const owner = await insertAccountWithActor(tx, {
        username: "linkowner",
        name: "Link Owner",
        email: "linkowner@example.com",
      });
      await tx.update(accountTable)
        .set({ leftInvitations: 5 })
        .where(eq(accountTable.id, owner.account.id));

      const result = await execute({
        schema,
        document: createInvitationLinkMutation,
        variableValues: {
          invitationsLeft: 2,
          message: "Welcome aboard",
          expires: "3 days",
        },
        contextValue: makeUserContext(tx, {
          ...owner.account,
          leftInvitations: 5,
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const payload = (result.data as {
        createInvitationLink: {
          __typename: string;
          account?: { username: string };
          invitationLink?: {
            uuid: string;
            invitationsLeft: number;
            message: string | null;
          } | null;
        };
      }).createInvitationLink;
      assertEquals(payload.__typename, "InvitationLinkPayload");
      assertEquals(payload.account?.username, "linkowner");
      assertEquals(payload.invitationLink?.invitationsLeft, 2);
      assertEquals(payload.invitationLink?.message, "Welcome aboard");
      assert(payload.invitationLink?.uuid != null);

      const storedAccount = await tx.query.accountTable.findFirst({
        where: { id: owner.account.id },
      });
      assertEquals(storedAccount?.leftInvitations, 3);

      const linkId = payload.invitationLink
        .uuid as `${string}-${string}-${string}-${string}-${string}`;
      const storedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assertEquals(storedLink?.invitationsLeft, 2);

      const deleteResult = await execute({
        schema,
        document: deleteInvitationLinkMutation,
        variableValues: { id: linkId },
        contextValue: makeUserContext(tx, {
          ...owner.account,
          leftInvitations: 3,
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(deleteResult.errors, undefined);
      const deletedPayload = (deleteResult.data as {
        deleteInvitationLink: {
          __typename: string;
          account?: { username: string };
          invitationLink: null;
        };
      }).deleteInvitationLink;
      assertEquals(deletedPayload.__typename, "InvitationLinkPayload");
      assertEquals(deletedPayload.account?.username, "linkowner");
      assertEquals(deletedPayload.invitationLink, null);

      const refundedAccount = await tx.query.accountTable.findFirst({
        where: { id: owner.account.id },
      });
      assertEquals(refundedAccount?.leftInvitations, 5);
      const deletedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assertEquals(deletedLink, undefined);
    });
  },
});

Deno.test({
  name: "redeemInvitationLink validates verify URL origin",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const owner = await insertAccountWithActor(tx, {
        username: "linkredeemowner",
        name: "Link Redeem Owner",
        email: "linkredeemowner@example.com",
      });
      const linkId = crypto
        .randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
      await tx.insert(invitationLinkTable).values({
        id: linkId,
        inviterId: owner.account.id,
        invitationsLeft: 1,
      });

      const result = await execute({
        schema,
        document: redeemInvitationLinkMutation,
        variableValues: {
          id: linkId,
          email: "redeem@example.com",
          locale: "en-US",
          verifyUrl: "https://evil.example/sign/up/{token}?code={code}",
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const validation = (result.data as {
        redeemInvitationLink: {
          __typename: string;
          verifyUrl: string | null;
          email: string | null;
          link: string | null;
          sendFailed: boolean | null;
        };
      }).redeemInvitationLink;
      assertEquals(
        validation.__typename,
        "RedeemInvitationLinkValidationErrors",
      );
      assertEquals(validation.verifyUrl, "VERIFY_URL_INVALID_ORIGIN");
      assertEquals(validation.email, null);
      assertEquals(validation.link, null);
      assertEquals(validation.sendFailed, null);
    });
  },
});

Deno.test({
  name: "redeemInvitationLink decrements the link and stores a signup token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv, store } = createTestKv();
      const email = createTestEmailTransport();
      const owner = await insertAccountWithActor(tx, {
        username: "redeemsuccessowner",
        name: "Redeem Success Owner",
        email: "redeemsuccessowner@example.com",
      });
      const linkId = crypto
        .randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
      await tx.insert(invitationLinkTable).values({
        id: linkId,
        inviterId: owner.account.id,
        invitationsLeft: 1,
        message: "Hello",
      });

      const result = await execute({
        schema,
        document: redeemInvitationLinkMutation,
        variableValues: {
          id: linkId,
          email: "redeem@example.com",
          locale: "en-US",
          verifyUrl: "http://localhost/sign/up/{token}?code={code}",
        },
        contextValue: makeGuestContext(tx, { kv, email: email.transport }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const payload = (result.data as {
        redeemInvitationLink: {
          __typename: string;
          email?: string;
          invitationLink?: { uuid: string };
        };
      }).redeemInvitationLink;
      assertEquals(payload.__typename, "RedeemInvitationLinkSuccess");
      assertEquals(payload.email, "redeem@example.com");
      assertEquals(payload.invitationLink?.uuid, linkId);
      assertEquals(email.messages.length, 1);

      const storedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assertEquals(storedLink?.invitationsLeft, 0);

      const signupEntries = [...store.entries()].filter(([key]) =>
        key.startsWith("signup/")
      );
      assertEquals(signupEntries.length, 1);
      const token = signupEntries[0][1] as {
        email: string;
        inviterId?: string;
      };
      assertEquals(token.email, "redeem@example.com");
      assertEquals(token.inviterId, owner.account.id);
    });
  },
});

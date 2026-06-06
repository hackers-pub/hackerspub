import assert from "node:assert";
import test from "node:test";
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

test(
  "createInvitationLink and deleteInvitationLink update invitation balances",
  async () => {
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

      assert.deepEqual(result.errors, undefined);

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
      assert.deepEqual(payload.__typename, "InvitationLinkPayload");
      assert.deepEqual(payload.account?.username, "linkowner");
      assert.deepEqual(payload.invitationLink?.invitationsLeft, 2);
      assert.deepEqual(payload.invitationLink?.message, "Welcome aboard");
      assert.ok(payload.invitationLink?.uuid != null);

      const storedAccount = await tx.query.accountTable.findFirst({
        where: { id: owner.account.id },
      });
      assert.deepEqual(storedAccount?.leftInvitations, 3);

      const linkId = payload.invitationLink
        .uuid as `${string}-${string}-${string}-${string}-${string}`;
      const storedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assert.deepEqual(storedLink?.invitationsLeft, 2);

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

      assert.deepEqual(deleteResult.errors, undefined);
      const deletedPayload = (deleteResult.data as {
        deleteInvitationLink: {
          __typename: string;
          account?: { username: string };
          invitationLink: null;
        };
      }).deleteInvitationLink;
      assert.deepEqual(deletedPayload.__typename, "InvitationLinkPayload");
      assert.deepEqual(deletedPayload.account?.username, "linkowner");
      assert.deepEqual(deletedPayload.invitationLink, null);

      const refundedAccount = await tx.query.accountTable.findFirst({
        where: { id: owner.account.id },
      });
      assert.deepEqual(refundedAccount?.leftInvitations, 5);
      const deletedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assert.deepEqual(deletedLink, undefined);
    });
  },
);

test("redeemInvitationLink validates verify URL origin", async () => {
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

    assert.deepEqual(result.errors, undefined);
    const validation = (result.data as {
      redeemInvitationLink: {
        __typename: string;
        verifyUrl: string | null;
        email: string | null;
        link: string | null;
        sendFailed: boolean | null;
      };
    }).redeemInvitationLink;
    assert.deepEqual(
      validation.__typename,
      "RedeemInvitationLinkValidationErrors",
    );
    assert.deepEqual(validation.verifyUrl, "VERIFY_URL_INVALID_ORIGIN");
    assert.deepEqual(validation.email, null);
    assert.deepEqual(validation.link, null);
    assert.deepEqual(validation.sendFailed, null);
  });
});

test(
  "redeemInvitationLink decrements the link and stores a signup token",
  async () => {
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

      assert.deepEqual(result.errors, undefined);

      const payload = (result.data as {
        redeemInvitationLink: {
          __typename: string;
          email?: string;
          invitationLink?: { uuid: string };
        };
      }).redeemInvitationLink;
      assert.deepEqual(payload.__typename, "RedeemInvitationLinkSuccess");
      assert.deepEqual(payload.email, "redeem@example.com");
      assert.deepEqual(payload.invitationLink?.uuid, linkId);
      assert.deepEqual(email.messages.length, 1);

      const storedLink = await tx.query.invitationLinkTable.findFirst({
        where: { id: linkId },
      });
      assert.deepEqual(storedLink?.invitationsLeft, 0);

      const signupEntries = [...store.entries()].filter(([key]) =>
        key.startsWith("signup/")
      );
      assert.deepEqual(signupEntries.length, 1);
      const token = signupEntries[0][1] as {
        email: string;
        inviterId?: string;
      };
      assert.deepEqual(token.email, "redeem@example.com");
      assert.deepEqual(token.inviterId, owner.account.id);
    });
  },
);

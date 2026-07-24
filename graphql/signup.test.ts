import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { getSession } from "@hackerspub/models/session";
import { deletedAccountTable } from "@hackerspub/models/schema";
import { createSignupToken, getSignupToken } from "@hackerspub/models/signup";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

const verifySignupTokenQuery = parse(`
  query VerifySignupToken($token: UUID!, $code: String!) {
    verifySignupToken(token: $token, code: $code) {
      email
      inviter {
        id
      }
    }
  }
`);

const completeSignupMutation = parse(`
  mutation CompleteSignup(
    $token: UUID!
    $code: String!
    $input: SignupInput!
  ) {
    completeSignup(token: $token, code: $code, input: $input) {
      __typename
      ... on Session {
        id
        account {
          id
          username
        }
      }
      ... on SignupValidationErrors {
        username
        name
        bio
      }
    }
  }
`);

test("verifySignupToken returns signup info for a valid token", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const inviter = await insertAccountWithActor(tx, {
      username: "signupinviter",
      name: "Signup Inviter",
      email: "signupinviter@example.com",
    });
    const signupToken = await createSignupToken(kv, "new@example.com", {
      inviterId: inviter.account.id,
    });

    const result = await execute({
      schema,
      document: verifySignupTokenQuery,
      variableValues: {
        token: signupToken.token,
        code: signupToken.code,
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (
        result.data as {
          verifySignupToken: {
            email: string;
            inviter: { id: string } | null;
          } | null;
        }
      ).verifySignupToken,
      {
        email: "new@example.com",
        inviter: { id: encodeGlobalID("Account", inviter.account.id) },
      },
    );
  });
});

test("completeSignup returns validation errors for a taken username", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    await insertAccountWithActor(tx, {
      username: "takenuser",
      name: "Taken User",
      email: "taken@example.com",
    });
    const signupToken = await createSignupToken(kv, "candidate@example.com");

    const result = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: signupToken.token,
        code: signupToken.code,
        input: {
          username: "takenuser",
          name: "Candidate",
          bio: "Hello",
        },
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (
        result.data as {
          completeSignup: {
            __typename: string;
            username?: string | null;
            name?: string | null;
            bio?: string | null;
          };
        }
      ).completeSignup,
      {
        __typename: "SignupValidationErrors",
        username: "USERNAME_ALREADY_TAKEN",
        name: null,
        bio: null,
      },
    );
  });
});

test("completeSignup rejects usernames reserved by deleted accounts", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    await tx.insert(deletedAccountTable).values({
      accountId: generateUuidV7(),
      username: "deletedsignup",
      actorIri: "http://localhost/ap/actors/deletedsignup",
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });
    const signupToken = await createSignupToken(kv, "reserved@example.com");

    const result = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: signupToken.token,
        code: signupToken.code,
        input: {
          username: "deletedsignup",
          name: "Reserved Candidate",
          bio: "Hello",
        },
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (
        result.data as {
          completeSignup: {
            __typename: string;
            username?: string | null;
            name?: string | null;
            bio?: string | null;
          };
        }
      ).completeSignup,
      {
        __typename: "SignupValidationErrors",
        username: "USERNAME_ALREADY_TAKEN",
        name: null,
        bio: null,
      },
    );
  });
});

test("completeSignup creates an account, session, and inviter follows", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const inviter = await insertAccountWithActor(tx, {
      username: "completeinviter",
      name: "Complete Inviter",
      email: "completeinviter@example.com",
    });
    const signupToken = await createSignupToken(kv, "fresh@example.com", {
      inviterId: inviter.account.id,
    });

    const result = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: signupToken.token,
        code: signupToken.code,
        input: {
          username: "freshuser",
          name: "Fresh User",
          bio: "Fresh bio",
        },
      },
      contextValue: makeGuestContext(tx, {
        kv,
        request: new Request("http://localhost/graphql", {
          headers: { "user-agent": "signup-test" },
        }),
      }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);

    const sessionPayload = (
      result.data as {
        completeSignup: {
          __typename: string;
          id?: string;
          account?: { id: string; username: string };
        };
      }
    ).completeSignup;
    assert.deepEqual(sessionPayload.__typename, "Session");
    assert.deepEqual(sessionPayload.account?.username, "freshuser");
    assert.ok(sessionPayload.id != null);
    const sessionId =
      sessionPayload.id as `${string}-${string}-${string}-${string}-${string}`;

    const account = await tx.query.accountTable.findFirst({
      where: { username: "freshuser" },
      with: { actor: true, emails: true },
    });
    assert.ok(account != null);
    assert.deepEqual(account.inviterId, inviter.account.id);
    assert.deepEqual(
      account.emails.map((email) => email.email),
      ["fresh@example.com"],
    );

    const storedSession = await getSession(kv, sessionId);
    assert.deepEqual(storedSession?.accountId, account.id);
    assert.deepEqual(storedSession?.userAgent, "signup-test");

    const storedToken = await getSignupToken(kv, signupToken.token);
    assert.deepEqual(storedToken, undefined);

    const followings = await tx.query.followingTable.findMany({
      where: {
        OR: [
          { followerId: account.actor.id, followeeId: inviter.actor.id },
          { followerId: inviter.actor.id, followeeId: account.actor.id },
        ],
      },
    });
    assert.deepEqual(followings.length, 2);
    assert.ok(followings.every((following) => following.accepted != null));
  });
});

import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { getSession } from "@hackerspub/models/session";
import { createSignupToken, getSignupToken } from "@hackerspub/models/signup";
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

Deno.test({
  name: "verifySignupToken returns signup info for a valid token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          verifySignupToken: {
            email: string;
            inviter: { id: string } | null;
          } | null;
        }).verifySignupToken,
        {
          email: "new@example.com",
          inviter: { id: encodeGlobalID("Account", inviter.account.id) },
        },
      );
    });
  },
});

Deno.test({
  name: "completeSignup returns validation errors for a taken username",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          completeSignup: {
            __typename: string;
            username?: string | null;
            name?: string | null;
            bio?: string | null;
          };
        }).completeSignup,
        {
          __typename: "SignupValidationErrors",
          username: "USERNAME_ALREADY_TAKEN",
          name: null,
          bio: null,
        },
      );
    });
  },
});

Deno.test({
  name: "completeSignup creates an account, session, and inviter follows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);

      const sessionPayload = (result.data as {
        completeSignup: {
          __typename: string;
          id?: string;
          account?: { id: string; username: string };
        };
      }).completeSignup;
      assertEquals(sessionPayload.__typename, "Session");
      assertEquals(sessionPayload.account?.username, "freshuser");
      assert(sessionPayload.id != null);
      const sessionId = sessionPayload
        .id as `${string}-${string}-${string}-${string}-${string}`;

      const account = await tx.query.accountTable.findFirst({
        where: { username: "freshuser" },
        with: { actor: true, emails: true },
      });
      assert(account != null);
      assertEquals(account.inviterId, inviter.account.id);
      assertEquals(account.emails.map((email) => email.email), [
        "fresh@example.com",
      ]);

      const storedSession = await getSession(kv, sessionId);
      assertEquals(storedSession?.accountId, account.id);
      assertEquals(storedSession?.userAgent, "signup-test");

      const storedToken = await getSignupToken(kv, signupToken.token);
      assertEquals(storedToken, undefined);

      const followings = await tx.query.followingTable.findMany({
        where: {
          OR: [
            { followerId: account.actor.id, followeeId: inviter.actor.id },
            { followerId: inviter.actor.id, followeeId: account.actor.id },
          ],
        },
      });
      assertEquals(followings.length, 2);
      assert(followings.every((following) => following.accepted != null));
    });
  },
});

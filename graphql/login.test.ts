import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { createSession, getSession } from "@hackerspub/models/session";
import { getSigninToken } from "@hackerspub/models/signin";
import { schema } from "./mod.ts";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";
import { execute, parse } from "graphql";

const loginByUsernameMutation = parse(`
  mutation LoginByUsername(
    $username: String!
    $locale: Locale!
    $verifyUrl: URITemplate!
  ) {
    loginByUsername(
      username: $username
      locale: $locale
      verifyUrl: $verifyUrl
    ) {
      __typename
      ... on LoginChallenge {
        token
        account {
          username
        }
      }
      ... on AccountNotFoundError {
        query
      }
    }
  }
`);

const loginByEmailMutation = parse(`
  mutation LoginByEmail(
    $email: String!
    $locale: Locale!
    $verifyUrl: URITemplate!
  ) {
    loginByEmail(email: $email, locale: $locale, verifyUrl: $verifyUrl) {
      __typename
      ... on LoginChallenge {
        token
        account {
          username
        }
      }
      ... on AccountNotFoundError {
        query
      }
    }
  }
`);

const completeLoginChallengeMutation = parse(`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      id
      account {
        username
      }
    }
  }
`);

const revokeSessionMutation = parse(`
  mutation RevokeSession($sessionId: UUID!) {
    revokeSession(sessionId: $sessionId) {
      id
    }
  }
`);

Deno.test({
  name:
    "loginByUsername creates a challenge and completeLoginChallenge issues a session",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const email = createTestEmailTransport();
      await insertAccountWithActor(tx, {
        username: "loginuser",
        name: "Login User",
        email: "loginuser@example.com",
      });

      const challengeResult = await execute({
        schema,
        document: loginByUsernameMutation,
        variableValues: {
          username: "loginuser",
          locale: "en-US",
          verifyUrl: "http://localhost/sign/in/{token}?code={code}",
        },
        contextValue: makeGuestContext(tx, { kv, email: email.transport }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(challengeResult.errors, undefined);

      const challenge = (challengeResult.data as {
        loginByUsername: {
          __typename: string;
          token?: string;
          account?: { username: string };
        };
      }).loginByUsername;
      assertEquals(challenge.__typename, "LoginChallenge");
      assertEquals(challenge.account?.username, "loginuser");
      assert(challenge.token != null);
      assertEquals(email.messages.length, 1);

      const signinToken = await getSigninToken(
        kv,
        challenge.token as `${string}-${string}-${string}-${string}-${string}`,
      );
      assert(signinToken != null);

      const sessionResult = await execute({
        schema,
        document: completeLoginChallengeMutation,
        variableValues: {
          token: challenge.token,
          code: signinToken.code,
        },
        contextValue: makeGuestContext(tx, {
          kv,
          request: new Request("http://localhost/graphql", {
            headers: { "user-agent": "login-test" },
          }),
        }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(sessionResult.errors, undefined);

      const session = (sessionResult.data as {
        completeLoginChallenge: {
          id: string;
          account: { username: string };
        } | null;
      }).completeLoginChallenge;
      assert(session != null);
      assertEquals(session.account.username, "loginuser");

      const storedSession = await getSession(
        kv,
        session.id as `${string}-${string}-${string}-${string}-${string}`,
      );
      assertEquals(storedSession?.userAgent, "login-test");
      assertEquals(
        await getSigninToken(
          kv,
          challenge
            .token as `${string}-${string}-${string}-${string}-${string}`,
        ),
        undefined,
      );
    });
  },
});

Deno.test({
  name: "loginByEmail matches email case-insensitively",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const email = createTestEmailTransport();
      await insertAccountWithActor(tx, {
        username: "emailloginuser",
        name: "Email Login User",
        email: "EmailLogin@Example.com",
      });

      const result = await execute({
        schema,
        document: loginByEmailMutation,
        variableValues: {
          email: "emaillogin@example.com",
          locale: "en-US",
          verifyUrl: "http://localhost/sign/in/{token}?code={code}",
        },
        contextValue: makeGuestContext(tx, { kv, email: email.transport }),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const challenge = (result.data as {
        loginByEmail: {
          __typename: string;
          account?: { username: string };
          token?: string;
        };
      }).loginByEmail;
      assertEquals(challenge.__typename, "LoginChallenge");
      assertEquals(challenge.account?.username, "emailloginuser");
      assert(challenge.token != null);
      assertEquals(email.messages.length, 1);
    });
  },
});

Deno.test({
  name: "revokeSession only revokes sessions for the current account",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "revokeowner",
        name: "Revoke Owner",
        email: "revokeowner@example.com",
      });
      const other = await insertAccountWithActor(tx, {
        username: "revokeother",
        name: "Revoke Other",
        email: "revokeother@example.com",
      });

      const currentContext = makeUserContext(tx, account.account, { kv });
      const extraSession = await createSession(kv, {
        accountId: account.account.id,
        userAgent: "extra-session",
      });

      await execute({
        schema,
        document: revokeSessionMutation,
        variableValues: { sessionId: extraSession.id },
        contextValue: currentContext,
        onError: "NO_PROPAGATE",
      });

      assertEquals(await getSession(kv, extraSession.id), undefined);

      const otherContext = makeUserContext(tx, other.account, { kv });
      const foreignResult = await execute({
        schema,
        document: revokeSessionMutation,
        variableValues: { sessionId: extraSession.id },
        contextValue: otherContext,
        onError: "NO_PROPAGATE",
      });

      assertEquals(foreignResult.errors, undefined);
      assertEquals(
        (foreignResult.data as { revokeSession: null }).revokeSession,
        null,
      );
    });
  },
});

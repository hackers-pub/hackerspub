import assert from "node:assert";
import test from "node:test";
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

test(
  "loginByUsername creates a challenge and completeLoginChallenge issues a session",
  async () => {
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

      assert.deepEqual(challengeResult.errors, undefined);

      const challenge = (challengeResult.data as {
        loginByUsername: {
          __typename: string;
          token?: string;
          account?: { username: string };
        };
      }).loginByUsername;
      assert.deepEqual(challenge.__typename, "LoginChallenge");
      assert.deepEqual(challenge.account?.username, "loginuser");
      assert.ok(challenge.token != null);
      assert.deepEqual(email.messages.length, 1);

      const signinToken = await getSigninToken(
        kv,
        challenge.token as `${string}-${string}-${string}-${string}-${string}`,
      );
      assert.ok(signinToken != null);

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

      assert.deepEqual(sessionResult.errors, undefined);

      const session = (sessionResult.data as {
        completeLoginChallenge: {
          id: string;
          account: { username: string };
        } | null;
      }).completeLoginChallenge;
      assert.ok(session != null);
      assert.deepEqual(session.account.username, "loginuser");

      const storedSession = await getSession(
        kv,
        session.id as `${string}-${string}-${string}-${string}-${string}`,
      );
      assert.deepEqual(storedSession?.userAgent, "login-test");
      assert.deepEqual(
        await getSigninToken(
          kv,
          challenge
            .token as `${string}-${string}-${string}-${string}-${string}`,
        ),
        undefined,
      );
    });
  },
);

test("loginByEmail matches email case-insensitively", async () => {
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

    assert.deepEqual(result.errors, undefined);
    const challenge = (result.data as {
      loginByEmail: {
        __typename: string;
        account?: { username: string };
        token?: string;
      };
    }).loginByEmail;
    assert.deepEqual(challenge.__typename, "LoginChallenge");
    assert.deepEqual(challenge.account?.username, "emailloginuser");
    assert.ok(challenge.token != null);
    assert.deepEqual(email.messages.length, 1);
  });
});

test("revokeSession only revokes sessions for the current account", async () => {
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
    const otherContext = makeUserContext(tx, other.account, { kv });

    const foreignResult = await execute({
      schema,
      document: revokeSessionMutation,
      variableValues: { sessionId: extraSession.id },
      contextValue: otherContext,
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(foreignResult.errors, undefined);
    assert.deepEqual(
      (foreignResult.data as { revokeSession: null }).revokeSession,
      null,
    );
    assert.ok((await getSession(kv, extraSession.id)) != null);

    await execute({
      schema,
      document: revokeSessionMutation,
      variableValues: { sessionId: extraSession.id },
      contextValue: currentContext,
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(await getSession(kv, extraSession.id), undefined);
  });
});

import assert from "node:assert";
import test from "node:test";
import { actorTable } from "@hackerspub/models/schema";
import { createSession, getSession } from "@hackerspub/models/session";
import { createSigninToken, getSigninToken } from "@hackerspub/models/signin";
import { eq } from "drizzle-orm";
import { createYogaServer, schema } from "./mod.ts";
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
      __typename
      ... on Session {
        id
        account {
          username
        }
      }
      ... on AccountBannedError {
        since
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

test(
  "completeLoginChallenge rejects a banned account with AccountBannedError",
  async () => {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const { account } = await insertAccountWithActor(tx, {
        username: "banneduser",
        name: "Banned User",
        email: "banneduser@example.com",
      });
      const since = new Date("2026-05-01T00:00:00.000Z");
      await tx.update(actorTable)
        .set({ suspended: since, suspendedUntil: null })
        .where(eq(actorTable.accountId, account.id));

      const signinToken = await createSigninToken(kv, account.id);

      const result = await execute({
        schema,
        document: completeLoginChallengeMutation,
        variableValues: {
          token: signinToken.token,
          code: signinToken.code,
        },
        contextValue: makeGuestContext(tx, { kv }),
        onError: "NO_PROPAGATE",
      });

      assert.deepEqual(result.errors, undefined);
      const data = (result.data as {
        completeLoginChallenge:
          | { __typename: string; since?: string; id?: string }
          | null;
      }).completeLoginChallenge;
      assert.deepEqual(data?.__typename, "AccountBannedError");
      assert.equal(new Date(data?.since as string).getTime(), since.getTime());
      assert.deepEqual(data?.id, undefined);

      // The challenge token is left intact (not consumed) so a retry is
      // still rejected the same way rather than silently succeeding.
      assert.ok((await getSigninToken(kv, signinToken.token)) != null);
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

test("organization accounts cannot start or complete direct login flows", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const email = createTestEmailTransport();
    const organization = await insertAccountWithActor(tx, {
      username: "organizationlogin",
      name: "Organization Login",
      email: "organizationlogin@example.com",
      type: "Organization",
    });

    const usernameResult = await execute({
      schema,
      document: loginByUsernameMutation,
      variableValues: {
        username: "organizationlogin",
        locale: "en-US",
        verifyUrl: "http://localhost/sign/in/{token}?code={code}",
      },
      contextValue: makeGuestContext(tx, { kv, email: email.transport }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(usernameResult.errors, undefined);
    assert.deepEqual(
      (usernameResult.data as {
        loginByUsername: { __typename: string; query?: string };
      }).loginByUsername,
      {
        __typename: "AccountNotFoundError",
        query: "organizationlogin",
      },
    );

    const emailResult = await execute({
      schema,
      document: loginByEmailMutation,
      variableValues: {
        email: "organizationlogin@example.com",
        locale: "en-US",
        verifyUrl: "http://localhost/sign/in/{token}?code={code}",
      },
      contextValue: makeGuestContext(tx, { kv, email: email.transport }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(emailResult.errors, undefined);
    assert.deepEqual(
      (emailResult.data as {
        loginByEmail: { __typename: string; query?: string };
      }).loginByEmail,
      {
        __typename: "AccountNotFoundError",
        query: "organizationlogin@example.com",
      },
    );
    assert.deepEqual(email.messages.length, 0);

    const signinToken = await createSigninToken(kv, organization.account.id);
    const completeResult = await execute({
      schema,
      document: completeLoginChallengeMutation,
      variableValues: {
        token: signinToken.token,
        code: signinToken.code,
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(completeResult.errors, undefined);
    assert.deepEqual(
      (completeResult.data as { completeLoginChallenge: null })
        .completeLoginChallenge,
      null,
    );
    assert.deepEqual(await getSigninToken(kv, signinToken.token), undefined);
  });
});

test("stale organization sessions are invalidated by the GraphQL context", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const organization = await insertAccountWithActor(tx, {
      username: "organizationsession",
      name: "Organization Session",
      email: "organizationsession@example.com",
      type: "Organization",
    });
    const session = await createSession(kv, {
      accountId: organization.account.id,
      userAgent: "stale-organization-session",
    });
    const yoga = createYogaServer();

    const response = await yoga.fetch(
      new Request("http://localhost/graphql?no-propagate=true", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${session.id}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { username } }" }),
      }),
      makeGuestContext(tx, { kv }),
    );
    const payload = await response.json() as {
      data?: { viewer: { username: string } | null };
      errors?: { message: string }[];
    };

    assert.deepEqual(payload.errors, undefined);
    assert.deepEqual(payload.data, { viewer: null });
    assert.equal(await getSession(kv, session.id), undefined);
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

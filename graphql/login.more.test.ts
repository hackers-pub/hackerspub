import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { createSigninToken } from "@hackerspub/models/signin";
import { schema } from "./mod.ts";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const loginByUsernameMutation = parse(`
  mutation LoginByUsername($username: String!, $locale: Locale!, $verifyUrl: URITemplate!) {
    loginByUsername(username: $username, locale: $locale, verifyUrl: $verifyUrl) {
      __typename
      ... on AccountNotFoundError { query }
    }
  }
`);

const loginByEmailMutation = parse(`
  mutation LoginByEmail($email: String!, $locale: Locale!, $verifyUrl: URITemplate!) {
    loginByEmail(email: $email, locale: $locale, verifyUrl: $verifyUrl) {
      __typename
      ... on AccountNotFoundError { query }
    }
  }
`);

const completeLoginChallengeMutation = parse(`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      id
    }
  }
`);

test("loginByUsername and loginByEmail return AccountNotFoundError for unknown accounts", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const email = createTestEmailTransport();

    const byUsername = await execute({
      schema,
      document: loginByUsernameMutation,
      variableValues: {
        username: "missing-user",
        locale: "en-US",
        verifyUrl: "http://localhost/sign/in/{token}?code={code}",
      },
      contextValue: makeGuestContext(tx, { kv, email: email.transport }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byUsername.errors, undefined);
    assert.deepEqual(toPlainJson(byUsername.data), {
      loginByUsername: {
        __typename: "AccountNotFoundError",
        query: "missing-user",
      },
    });

    const byEmail = await execute({
      schema,
      document: loginByEmailMutation,
      variableValues: {
        email: "missing@example.com",
        locale: "en-US",
        verifyUrl: "http://localhost/sign/in/{token}?code={code}",
      },
      contextValue: makeGuestContext(tx, { kv, email: email.transport }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byEmail.errors, undefined);
    assert.deepEqual(toPlainJson(byEmail.data), {
      loginByEmail: {
        __typename: "AccountNotFoundError",
        query: "missing@example.com",
      },
    });
  });
});

test("completeLoginChallenge returns null for wrong codes and missing tokens", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "loginchallengeowner",
      name: "Login Challenge Owner",
      email: "loginchallengeowner@example.com",
    });
    const token = await createSigninToken(kv, account.account.id);

    const wrongCode = await execute({
      schema,
      document: completeLoginChallengeMutation,
      variableValues: {
        token: token.token,
        code: "WRONGCODE",
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(wrongCode.errors, undefined);
    assert.deepEqual(toPlainJson(wrongCode.data), {
      completeLoginChallenge: null,
    });

    const missingToken = await execute({
      schema,
      document: completeLoginChallengeMutation,
      variableValues: {
        token: "019d9162-ffff-7fff-8fff-ffffffffffff",
        code: token.code,
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(missingToken.errors, undefined);
    assert.deepEqual(toPlainJson(missingToken.data), {
      completeLoginChallenge: null,
    });
  });
});

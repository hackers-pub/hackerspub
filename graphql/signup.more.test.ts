import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { createSignupToken } from "@hackerspub/models/signup";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const verifySignupTokenQuery = parse(`
  query VerifySignupToken($token: UUID!, $code: String!) {
    verifySignupToken(token: $token, code: $code) {
      email
    }
  }
`);

const completeSignupMutation = parse(`
  mutation CompleteSignup($token: UUID!, $code: String!, $input: SignupInput!) {
    completeSignup(token: $token, code: $code, input: $input) {
      __typename
      ... on SignupValidationErrors {
        username
        name
        bio
      }
      ... on Session {
        id
      }
    }
  }
`);

test("verifySignupToken returns null for wrong codes and already-registered emails", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const token = await createSignupToken(kv, "verify-me@example.com");

    const wrongCode = await execute({
      schema,
      document: verifySignupTokenQuery,
      variableValues: { token: token.token, code: "wrong" },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(wrongCode.errors, undefined);
    assert.deepEqual(toPlainJson(wrongCode.data), { verifySignupToken: null });

    await insertAccountWithActor(tx, {
      username: "registeredemail",
      name: "Registered Email",
      email: "verify-me@example.com",
    });

    const alreadyRegistered = await execute({
      schema,
      document: verifySignupTokenQuery,
      variableValues: { token: token.token, code: token.code },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(alreadyRegistered.errors, undefined);
    assert.deepEqual(toPlainJson(alreadyRegistered.data), {
      verifySignupToken: null,
    });
  });
});

test("completeSignup reports invalid token, invalid code, and duplicate email errors", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const token = await createSignupToken(kv, "duplicate@example.com");

    const invalidToken = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: "019d9162-ffff-7fff-8fff-ffffffffffff",
        code: token.code,
        input: { username: "newuser", name: "New User", bio: "Bio" },
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(invalidToken.data), { completeSignup: null });
    assert.equal(
      invalidToken.errors?.[0].message,
      "Invalid or expired signup token",
    );

    const invalidCode = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: token.token,
        code: "wrong-code",
        input: { username: "newuser", name: "New User", bio: "Bio" },
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(invalidCode.data), { completeSignup: null });
    assert.equal(invalidCode.errors?.[0].message, "Invalid verification code");

    await insertAccountWithActor(tx, {
      username: "duplicateowner",
      name: "Duplicate Owner",
      email: "duplicate@example.com",
    });

    const duplicateEmail = await execute({
      schema,
      document: completeSignupMutation,
      variableValues: {
        token: token.token,
        code: token.code,
        input: { username: "newuser", name: "New User", bio: "Bio" },
      },
      contextValue: makeGuestContext(tx, { kv }),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(duplicateEmail.data), {
      completeSignup: null,
    });
    assert.equal(
      duplicateEmail.errors?.[0].message,
      "Email is already registered",
    );
  });
});

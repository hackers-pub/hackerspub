import assert from "node:assert";
import test from "node:test";
import {
  isExpectedAuthError,
  isExpectedAuthResponse,
} from "./graphqlAuthError.ts";

const authError = {
  message: "Authentication required.",
  extensions: { code: "AUTHENTICATION_REQUIRED" },
};

test("isExpectedAuthError() accepts only authentication errors", () => {
  assert.equal(isExpectedAuthError([authError]), true);
  assert.equal(
    isExpectedAuthError([authError, { extensions: { code: "OTHER" } }]),
    false,
  );
});

test("isExpectedAuthResponse() recognizes singular and batched responses", () => {
  assert.equal(isExpectedAuthResponse({ errors: [authError] }), true);
  assert.equal(
    isExpectedAuthResponse([{ data: { viewer: {} } }, { errors: [authError] }]),
    true,
  );
  assert.equal(isExpectedAuthResponse([]), false);
  assert.equal(isExpectedAuthResponse({ data: { viewer: null } }), false);
});

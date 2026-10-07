import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { graphql } from "relay-runtime";
import { runPrivateMutation } from "./privateMutation.ts";
import type { securityProofOptionsMutation } from "./__generated__/securityProofOptionsMutation.graphql.ts";

const optionsMutation = graphql`
  mutation securityProofOptionsMutation($action: AccountSecurityAction!) {
    getAccountSecurityAuthenticationOptions(action: $action) {
      __typename
      ... on AccountSecurityAuthenticationOptions { challengeId options }
      ... on AccountSecurityError { code }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`;
export async function getSecurityProof(
  action: "ENABLE" | "DISABLE" | "REGENERATE" | "REGISTER" | "REVOKE",
) {
  const response = await runPrivateMutation<securityProofOptionsMutation>(
    optionsMutation,
    { action },
  );
  const result = response.getAccountSecurityAuthenticationOptions;
  if (result.__typename !== "AccountSecurityAuthenticationOptions")
    throw new Error(
      result.__typename === "AccountSecurityError"
        ? result.code
        : "NOT_AUTHENTICATED",
    );
  const authenticationResponse = await startAuthentication({
    optionsJSON: result.options as PublicKeyCredentialRequestOptionsJSON,
  });
  return { challengeId: result.challengeId, authenticationResponse };
}

import type { GraphQLResponse } from "relay-runtime";

async function unavailable(..._args: unknown[]): Promise<GraphQLResponse> {
  throw new Error(
    "The GraphQL upstream transport is only available on the server",
  );
}

export {
  unavailable as fetchInteractiveGraphQL,
  unavailable as fetchSsrGraphQL,
};

import { validateUuid } from "@hackerspub/models/uuid";
import { redirect } from "@solidjs/router";
import type { APIEvent } from "@solidjs/start/server";
import { commitMutation, graphql } from "relay-runtime";
import { getQuery, getRequestProtocol, setCookie } from "vinxi/http";
import { createEnvironment } from "~/RelayEnvironment.tsx";
import type {
  TokenCompleteMutation,
  TokenCompleteMutation$data,
} from "./__generated__/TokenCompleteMutation.graphql.ts";

export async function GET({ params, nativeEvent }: APIEvent) {
  if (!validateUuid(params.token)) {
    throw new Error("Invalid token"); // FIXME
  }
  const { token } = params;
  const query = getQuery(nativeEvent);
  if (query.code == null || typeof query.code !== "string") {
    throw new Error("Code is required"); // FIXME
  }
  const { code } = query;
  const response = await new Promise<TokenCompleteMutation$data>((
    resolve,
    reject,
  ) =>
    commitMutation<TokenCompleteMutation>(createEnvironment(), {
      mutation: graphql`
      mutation TokenCompleteMutation($token: UUID!, $code: String!) {
        completeLoginChallenge(token: $token, code: $code) {
          id
        }
      }
    `,
      variables: { token, code },
      onCompleted: (response, errors) => {
        if (errors != null) reject(new AggregateError(errors));
        else resolve(response);
      },
    })
  );
  if (response.completeLoginChallenge == null) {
    throw new Error("Invalid token or code"); // FIXME
  }
  const sessionId = response.completeLoginChallenge.id;
  setCookie(nativeEvent, "session", sessionId, {
    httpOnly: true,
    path: "/",
    expires: new Date(Date.now() + 365 * 60 * 60 * 24 * 1000), // 365 days
    secure: getRequestProtocol(nativeEvent) === "https",
  });
  return redirect("/");
}

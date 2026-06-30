import { EXPIRATION } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import { redirect } from "@solidjs/router";
import { getQuery } from "@solidjs/start/http";
import type { APIEvent } from "@solidjs/start/server";
import { commitMutation, graphql } from "relay-runtime";
import { createEnvironment } from "~/RelayEnvironment.tsx";
import {
  buildSessionSetCookieHeader,
  isSecureRequest,
} from "~/lib/sessionCookie.ts";
import type {
  TokenCompleteMutation,
  TokenCompleteMutation$data,
} from "./__generated__/TokenCompleteMutation.graphql.ts";

export async function GET({ params, nativeEvent, request }: APIEvent) {
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
          __typename
          ... on Session {
            id
          }
          ... on AccountBannedError {
            since
          }
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
  const result = response.completeLoginChallenge;
  if (result == null) {
    throw new Error("Invalid token or code"); // FIXME
  }
  if (result.__typename === "AccountBannedError") {
    // A permanently suspended (banned) account cannot sign in; bounce back
    // to the sign-in page, which surfaces a ban-specific notice.
    return redirect("/sign?error=banned");
  }
  if (result.__typename !== "Session") {
    throw new Error("Invalid token or code"); // FIXME
  }
  const sessionId = result.id;
  // Avoid setCookie(nativeEvent, ...): SolidStart 2.0.0-alpha.2 can produce a
  // malformed Set-Cookie name for API route handlers.
  const cookie = buildSessionSetCookieHeader(sessionId, {
    expires: new Date(Date.now() + EXPIRATION.total("millisecond")),
    secure: isSecureRequest(request),
  });
  const next = typeof query.next === "string" ? query.next : "/";
  return redirect(next, {
    headers: { "Set-Cookie": cookie },
  });
}

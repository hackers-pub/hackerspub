import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { Context } from "@hackerspub/graphql";
import { schema } from "@hackerspub/graphql";
import { execute, type ExecutionResult } from "graphql";
import { toe } from "graphql-toe";

export * from "./__generated__/index.ts";

export type QueryGraphQL = ReturnType<typeof makeQueryGraphQL>;

export function makeQueryGraphQL(context: Context) {
  return async function <
    TData extends Record<string, unknown> = Record<string, unknown>,
    TVariables extends { readonly [variable: string]: unknown } = Record<
      string,
      unknown
    >,
  >(operation: TypedDocumentNode<TData, TVariables>, variables?: TVariables) {
    const result = await execute({
      schema,
      document: operation,
      variableValues: variables,
      contextValue: context,
      onError: "NO_PROPAGATE",
    }) as ExecutionResult<TData, TVariables>;

    return toe(result);
  };
}

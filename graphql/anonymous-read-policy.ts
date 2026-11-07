import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import {
  getOperationAST,
  Kind,
  parse,
  print,
  separateOperations,
  type DocumentNode,
  type SelectionSetNode,
} from "graphql";
import type { UserContext } from "./builder.ts";
import { publicReadDocuments } from "./public-read-documents.ts";

const MAX_SHARED_DOCUMENT_BYTES = 32_768;
const MAX_SHARED_VARIABLE_BYTES = 16_384;
const approved = new Set(publicReadDocuments.map((text) => print(parse(text))));

function selectedDocument(
  document: DocumentNode,
  operationName?: string | null,
): DocumentNode | undefined {
  const operation = getOperationAST(document, operationName ?? undefined);
  if (operation?.operation !== "query") return undefined;
  return separateOperations(document)[operation.name?.value ?? ""];
}

/** Only these roots can execute without touching the database for a guest. */
export function isCheapGuestQuery(
  document: DocumentNode,
  operationName: string | null | undefined,
  context: Pick<UserContext, "session" | "account">,
): boolean {
  if (context.account != null || context.session != null) return false;
  const selected = selectedDocument(document, operationName);
  if (selected == null) return false;
  const fragments = new Map(
    selected.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION
        ? [[definition.name.value, definition] as const]
        : [],
    ),
  );
  const seen = new Set<string>();
  const check = (set: SelectionSetNode): boolean =>
    set.selections.every((selection) => {
      if (selection.kind === Kind.FIELD) {
        // viewer is terminal for guests, including its otherwise private tree.
        return [
          "viewer",
          "webPushVapidPublicKey",
          "suggestedFilterLanguages",
          "__typename",
        ].includes(selection.name.value);
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        return check(selection.selectionSet);
      }
      if (seen.has(selection.name.value)) return false;
      const fragment = fragments.get(selection.name.value);
      if (fragment == null) return false;
      seen.add(selection.name.value);
      const result = check(fragment.selectionSet);
      seen.delete(selection.name.value);
      return result;
    });
  const operation = getOperationAST(selected, operationName ?? undefined);
  return operation != null && check(operation.selectionSet);
}

/** Exact, audited documents only; arbitrary queries still receive admission. */
export function publicReadKey(
  document: DocumentNode,
  operationName: string | null | undefined,
  variables: Record<string, unknown> | null | undefined,
  request: Request,
): string | undefined {
  if (request.headers.has("authorization") || request.headers.has("cookie")) {
    return undefined;
  }
  const selected = selectedDocument(document, operationName);
  if (selected == null) return undefined;
  const text = print(selected);
  if (text.length > MAX_SHARED_DOCUMENT_BYTES || !approved.has(text)) {
    return undefined;
  }
  const encodedVariables = canonicalize(variables ?? {});
  if (encodedVariables.length > MAX_SHARED_VARIABLE_BYTES) return undefined;
  const url = new URL(request.url);
  // Include every request property read by this finite resolver tree or the
  // execution policy. Locale/cursor/filter variables are all included above.
  return createHash("sha256")
    .update(
      JSON.stringify([
        text,
        encodedVariables,
        url.origin,
        url.pathname,
        url.searchParams.get("no-propagate"),
        request.headers.get("x-no-propagate"),
        request.headers.get("accept-language"),
      ]),
    )
    .digest("hex");
}

import {
  ConnectionHandler,
  type RecordSourceProxy,
  type RecordSourceSelectorProxy,
} from "relay-runtime";

export interface CreatedPostConnectionUpdate {
  readonly rootFieldName: "createNote" | "createQuestion";
  readonly postFieldName: "note" | "question";
  readonly appendConnectionIds: readonly string[];
  readonly replyTargetId?: string | null;
  readonly actingAccountId?: string | null;
}

export function updateCreatedPostConnections(
  store: RecordSourceProxy | RecordSourceSelectorProxy,
  update: CreatedPostConnectionUpdate,
): boolean {
  const payload = "getRootField" in store
    ? store.getRootField(update.rootFieldName)
    : store.getRoot().getLinkedRecord(update.rootFieldName);
  const expectedPayload = update.rootFieldName === "createNote"
    ? "CreateNotePayload"
    : "CreateQuestionPayload";
  if (payload?.getValue("__typename") !== expectedPayload) return false;

  const post = payload.getLinkedRecord(update.postFieldName);
  if (post == null) return false;
  for (const connectionId of update.appendConnectionIds) {
    const connection = store.get(connectionId);
    if (connection == null) continue;
    const edge = ConnectionHandler.createEdge(
      store,
      connection,
      post,
      "PostDescendantsConnectionEdge",
    );
    ConnectionHandler.insertEdgeAfter(connection, edge);
  }

  if (update.replyTargetId == null) return true;
  const target = store.get(update.replyTargetId);
  const replies = target?.getLinkedRecord("replies", {
    first: 0,
    actingAccountId: update.actingAccountId ?? null,
  });
  const totalCount = replies?.getValue("totalCount");
  if (typeof totalCount === "number") {
    replies?.setValue(totalCount + 1, "totalCount");
  }
  return true;
}

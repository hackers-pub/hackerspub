import { ConnectionHandler, graphql } from "relay-runtime";
import { createMutation } from "solid-relay";
import type { createSubmissionControllerArticleDraftMutation } from "./__generated__/createSubmissionControllerArticleDraftMutation.graphql.ts";
import type { createSubmissionControllerCreateNoteMutation } from "./__generated__/createSubmissionControllerCreateNoteMutation.graphql.ts";
import type { createSubmissionControllerCreateQuestionMutation } from "./__generated__/createSubmissionControllerCreateQuestionMutation.graphql.ts";
import type { createSubmissionControllerUpdateNoteMutation } from "./__generated__/createSubmissionControllerUpdateNoteMutation.graphql.ts";
import type { ValidatedPollInput } from "./pollState.ts";
import { updateCreatedPostConnections } from "./relayUpdates.ts";
import {
  buildCreatePostInput,
  buildUpdateNoteInput,
  getNoteInternalHref,
  type SubmissionMedium,
  type SubmissionValidationError,
  validateSubmission,
} from "./submissionState.ts";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

const CreateNoteMutation = graphql`
  mutation createSubmissionControllerCreateNoteMutation(
    $input: CreateNoteInput!
    $connections: [ID!]!
    $includeDiscussionThreadFields: Boolean!
    $actingAccountId: ID
  ) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note
          @prependNode(
            connections: $connections
            edgeTypeName: "PostLinkSharingPostsConnectionEdge"
          ) {
          id
          uuid
          sourceId
          replyTarget(actingAccountId: $actingAccountId) {
            id
          }
          hasVisibleReplies(actingAccountId: $actingAccountId)
          actor {
            id
            handle
            username
            local
          }
          ...PermalinkThread_replyNode @arguments(
            actingAccountId: $actingAccountId
          )
          # Only news-discussion posts prepend into a connection and need the
          # row fields; skip them for every other compose/reply/quote path.
          ...NewsDiscussionThread_post
            @arguments(actingAccountId: $actingAccountId)
            @include(if: $includeDiscussionThreadFields)
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const CreateQuestionMutation = graphql`
  mutation createSubmissionControllerCreateQuestionMutation(
    $input: CreateQuestionInput!
    $connections: [ID!]!
    $includeDiscussionThreadFields: Boolean!
    $actingAccountId: ID
  ) {
    createQuestion(input: $input) {
      __typename
      ... on CreateQuestionPayload {
        question
          @prependNode(
            connections: $connections
            edgeTypeName: "PostLinkSharingPostsConnectionEdge"
          ) {
          id
          uuid
          sourceId
          replyTarget(actingAccountId: $actingAccountId) {
            id
          }
          hasVisibleReplies(actingAccountId: $actingAccountId)
          actor {
            id
          }
          ...PermalinkThread_replyNode @arguments(
            actingAccountId: $actingAccountId
          )
          ...NewsDiscussionThread_post
            @arguments(actingAccountId: $actingAccountId)
            @include(if: $includeDiscussionThreadFields)
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const UpdateNoteMutation = graphql`
  mutation createSubmissionControllerUpdateNoteMutation(
    $input: UpdateNoteInput!
  ) {
    updateNote(input: $input) {
      __typename
      ... on UpdateNotePayload {
        note {
          id
          content
          rawContent
          language
          quotePolicy
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const ArticleDraftMutation = graphql`
  mutation createSubmissionControllerArticleDraftMutation(
    $input: SaveArticleDraftInput!
    $connections: [ID!]!
  ) {
    saveArticleDraft(input: $input) {
      __typename
      ... on SaveArticleDraftPayload {
        draft
          @prependNode(
            connections: $connections
            edgeTypeName: "AccountArticleDraftsConnectionEdge"
          ) {
          id
          uuid
          title
          content
          tags
          updated
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

interface ActingAccountInput {
  readonly actingAccountId?: string;
}

export interface SubmissionControllerOptions {
  readonly content: () => string;
  readonly media: () => readonly SubmissionMedium[];
  readonly editingNoteId: () => string | null | undefined;
  readonly editingVisibility: () => PostVisibility | null | undefined;
  readonly editingAuthorAccountId: () => string | null | undefined;
  readonly language: () => string | undefined;
  readonly fallbackLanguage: () => string;
  readonly visibility: () => PostVisibility;
  readonly quotePolicy: () => QuotePolicy;
  readonly quotedPostId: () => string | null | undefined;
  readonly replyTargetId: () => string | null | undefined;
  readonly ensureLinkUrl: () => string | null | undefined;
  readonly actingAccountInput: () => ActingAccountInput;
  readonly prependToConnections: () => readonly string[];
  readonly appendToConnections: () => readonly string[];
  readonly viewerId: () => string | null | undefined;
  readonly username: () => string | null | undefined;
  readonly pollEnabled: () => boolean;
  readonly validatedPoll: () => ValidatedPollInput | null;
  readonly canSwitchToArticle: () => boolean;
  readonly saveDraftNow: () => boolean;
  readonly clearDraft: () => void;
  readonly resetForm: () => void;
  readonly onSuccess: () => void;
  readonly onArticleSwitch: () => void;
  readonly navigate: (href: string) => void;
}

export interface SubmissionController {
  readonly submit: (event: Event) => void;
  readonly switchToArticleDraft: () => void;
  readonly creating: () => boolean;
  readonly creatingQuestion: () => boolean;
  readonly updating: () => boolean;
  readonly savingArticleDraft: () => boolean;
  readonly submitting: () => boolean;
}

export function createSubmissionController(
  options: SubmissionControllerOptions,
): SubmissionController {
  const { t } = useLingui();
  const [createNote, creating] = createMutation<
    createSubmissionControllerCreateNoteMutation
  >(CreateNoteMutation);
  const [createQuestion, creatingQuestion] = createMutation<
    createSubmissionControllerCreateQuestionMutation
  >(CreateQuestionMutation);
  const [updateNote, updating] = createMutation<
    createSubmissionControllerUpdateNoteMutation
  >(UpdateNoteMutation);
  const [saveArticleDraft, savingArticleDraft] = createMutation<
    createSubmissionControllerArticleDraftMutation
  >(ArticleDraftMutation);

  const submitting = () =>
    creating() || creatingQuestion() || updating() || savingArticleDraft();

  const showValidationError = (error: SubmissionValidationError) => {
    const description = error === "empty-content"
      ? t`Content cannot be empty`
      : error === "uploading-media"
      ? t`All images must finish uploading before posting`
      : error === "failed-media-upload"
      ? t`Failed to upload image`
      : t`All images require alt text`;
    showToast({ title: t`Error`, description, variant: "error" });
  };

  const finish = () => {
    options.clearDraft();
    options.resetForm();
    options.onSuccess();
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const validation = validateSubmission(options.content(), options.media());
    if (!validation.ok) {
      showValidationError(validation.error);
      return;
    }

    const noteId = options.editingNoteId();
    if (noteId != null) {
      updateNote({
        variables: {
          input: buildUpdateNoteInput({
            noteId,
            content: validation.content,
            language: options.language(),
            quotePolicy: options.quotePolicy(),
            visibility: options.editingVisibility(),
            actingAccountId: options.editingAuthorAccountId() ?? undefined,
          }),
        },
        onCompleted(response) {
          if (response.updateNote.__typename === "UpdateNotePayload") {
            showToast({
              title: t`Success`,
              description: t`Note updated`,
              variant: "success",
            });
            finish();
          } else if (response.updateNote.__typename === "InvalidInputError") {
            showToast({
              title: t`Error`,
              description: t`Invalid input: ${response.updateNote.inputPath}`,
              variant: "error",
            });
          } else if (
            response.updateNote.__typename === "NotAuthenticatedError"
          ) {
            showToast({
              title: t`Error`,
              description: t`You must be signed in to edit a note`,
              variant: "error",
            });
          }
        },
        onError(error) {
          showToast({
            title: t`Error`,
            description: error.message,
            variant: "error",
          });
        },
      });
      return;
    }

    const actingAccountInput = options.actingAccountInput();
    const input = buildCreatePostInput({
      content: validation.content,
      ensureLinkUrl: options.ensureLinkUrl(),
      language: options.language(),
      fallbackLanguage: options.fallbackLanguage(),
      visibility: options.visibility(),
      quotePolicy: options.quotePolicy(),
      quotedPostId: options.quotedPostId(),
      replyTargetId: options.replyTargetId(),
      actingAccountInput,
      media: validation.media,
    });
    const connections = [...options.prependToConnections()];
    const mutationVariables = {
      connections,
      actingAccountId: actingAccountInput.actingAccountId ?? null,
      includeDiscussionThreadFields: connections.length > 0,
    };
    const connectionUpdate = {
      appendConnectionIds: options.appendToConnections(),
      replyTargetId: options.replyTargetId(),
      actingAccountId: actingAccountInput.actingAccountId,
    };

    if (options.pollEnabled()) {
      const poll = options.validatedPoll();
      if (poll == null) return;
      createQuestion({
        variables: { input: { ...input, poll }, ...mutationVariables },
        updater(store) {
          updateCreatedPostConnections(store, {
            ...connectionUpdate,
            rootFieldName: "createQuestion",
            postFieldName: "question",
          });
        },
        onCompleted(response) {
          if (
            response.createQuestion.__typename === "CreateQuestionPayload"
          ) {
            showToast({
              title: t`Success`,
              description: t`Poll created successfully`,
              variant: "success",
            });
            finish();
          } else if (
            response.createQuestion.__typename === "InvalidInputError"
          ) {
            showToast({
              title: t`Error`,
              description:
                t`Invalid input: ${response.createQuestion.inputPath}`,
              variant: "error",
            });
          } else if (
            response.createQuestion.__typename === "NotAuthenticatedError"
          ) {
            showToast({
              title: t`Error`,
              description: t`You must be signed in to create a poll`,
              variant: "error",
            });
          }
        },
        onError(error) {
          showToast({
            title: t`Error`,
            description: error.message,
            variant: "error",
          });
        },
      });
      return;
    }

    createNote({
      variables: { input, ...mutationVariables },
      updater(store) {
        updateCreatedPostConnections(store, {
          ...connectionUpdate,
          rootFieldName: "createNote",
          postFieldName: "note",
        });
      },
      onCompleted(response) {
        if (response.createNote.__typename === "CreateNotePayload") {
          showToast({
            title: t`Success`,
            description: t`Note created successfully`,
            href: getNoteInternalHref(response.createNote.note),
            variant: "success",
          });
          finish();
        } else if (response.createNote.__typename === "InvalidInputError") {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.createNote.inputPath}`,
            variant: "error",
          });
        } else if (
          response.createNote.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to create a note`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  const switchToArticleDraft = () => {
    const username = options.username();
    const content = options.content().trim();
    if (username == null) {
      showToast({
        title: t`Error`,
        description: t`You must be signed in to save a draft`,
        variant: "error",
      });
      return;
    }
    if (!options.canSwitchToArticle() || content === "") {
      options.onArticleSwitch();
      return;
    }

    options.saveDraftNow();
    const viewerId = options.viewerId();
    const connections = viewerId == null ? [] : [
      "SignedAccount_articleDrafts",
      "draftsPaginationFragment_articleDrafts",
      "FloatingComposeButton_articleDrafts",
    ].map((connectionKey) =>
      ConnectionHandler.getConnectionID(viewerId, connectionKey)
    );
    saveArticleDraft({
      variables: {
        input: { title: "", content, tags: [] },
        connections,
      },
      onCompleted(response) {
        if (
          response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
        ) {
          const articleDraft = response.saveArticleDraft.draft;
          options.clearDraft();
          options.resetForm();
          options.onArticleSwitch();
          showToast({
            title: t`Success`,
            description: t`Draft saved`,
            variant: "success",
          });
          options.navigate(
            `/@${encodeHandleSegment(username)}/drafts/${articleDraft.uuid}`,
          );
        } else if (
          response.saveArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description:
              t`Invalid input: ${response.saveArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.saveArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to save a draft`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  return {
    submit,
    switchToArticleDraft,
    creating,
    creatingQuestion,
    updating,
    savingArticleDraft,
    submitting,
  };
}

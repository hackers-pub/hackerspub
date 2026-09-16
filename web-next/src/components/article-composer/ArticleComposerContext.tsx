import { detectLanguage } from "~/lib/langdet.ts";
import {
  commitLocalUpdate,
  ConnectionHandler,
  fetchQuery,
  graphql,
} from "relay-runtime";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  type ParentComponent,
  untrack,
  useContext,
} from "solid-js";
import { isServer } from "solid-js/web";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { createStablePreloadedQuery } from "~/lib/relayPreload.ts";
import { showToast } from "~/components/ui/toast.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import {
  PERSONAL_COMPOSE_ACCOUNT_KEY,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { getBrowserLocalStorage } from "~/lib/browserStorage.ts";
import {
  buildNoteDraftContentFromArticle,
  shouldSuggestNoteForArticle,
} from "~/lib/formatGuidance.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  getNoteDraftStorageKey,
  readNoteDraft,
  writeNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import { publishNoteDraftChange } from "~/lib/noteDraftSync.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { useNavigate, useParams } from "@solidjs/router";
import {
  createDraftFormSnapshot,
  createDraftSaveInput,
  type DraftFormSnapshot,
  reconcileDraftSaveResponse,
} from "./draftSaveSnapshot.ts";
import { useAutoSave } from "./useAutoSave.ts";
import { useUnsavedGuard } from "./useUnsavedGuard.ts";
import type { ArticleComposerContextSaveMutation } from "./__generated__/ArticleComposerContextSaveMutation.graphql.ts";
import type { ArticleComposerContextPublishMutation } from "./__generated__/ArticleComposerContextPublishMutation.graphql.ts";
import type { ArticleComposerContextDeleteMutation } from "./__generated__/ArticleComposerContextDeleteMutation.graphql.ts";
import type { ArticleComposerContextMoveMutation } from "./__generated__/ArticleComposerContextMoveMutation.graphql.ts";
import type { ArticleComposerContextDraftQuery as ArticleComposerContextDraftQueryType } from "./__generated__/ArticleComposerContextDraftQuery.graphql.ts";

// --- GraphQL definitions ---

const SaveArticleDraftMutation = graphql`
  mutation ArticleComposerContextSaveMutation(
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
          contentHtml
          tags
          updated
          revision
          account {
            id
            kind
            username
          }
          creator {
            id
          }
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const PublishArticleDraftMutation = graphql`
  mutation ArticleComposerContextPublishMutation(
    $input: PublishArticleDraftInput!
  ) {
    publishArticleDraft(input: $input) {
      __typename
      ... on PublishArticleDraftPayload {
        article {
          id
          url
        }
        deletedDraftId @deleteRecord
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const MoveArticleDraftToOrganizationMutation = graphql`
  mutation ArticleComposerContextMoveMutation(
    $input: MoveArticleDraftToOrganizationInput!
  ) {
    moveArticleDraftToOrganization(input: $input) {
      __typename
      ... on MoveArticleDraftToOrganizationPayload {
        draft {
          id
          uuid
          revision
          account {
            id
            kind
            username
          }
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
      ... on OrganizationPermissionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const DeleteArticleDraftMutation = graphql`
  mutation ArticleComposerContextDeleteMutation(
    $input: DeleteArticleDraftInput!
    $connections: [ID!]!
  ) {
    deleteArticleDraft(input: $input) {
      __typename
      ... on DeleteArticleDraftPayload {
        deletedDraftId @deleteEdge(connections: $connections)
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const ArticleComposerDraftQuery = graphql`
  query ArticleComposerContextDraftQuery($uuid: UUID!) {
    articleDraft(uuid: $uuid) {
      id
      uuid
      title
      content
      contentHtml
      tags
      revision
      account {
        id
        kind
        username
      }
      creator {
        id
      }
    }
  }
`;

// --- Types ---

export interface ArticleComposerProps {
  draftUuid?: string;
  onSaved?: (
    draftId: string,
    draftUuid: string,
    workspaceUsername: string,
  ) => void;
  onPublished?: (articleUrl: string) => void;
  viewerId?: string;
  workspaceAccountId?: string;
  workspaceUsername?: string;
  workspaceKind?: "personal" | "organization";
}

export interface ArticleDraftWorkspaceOption {
  value: string;
  accountId?: string;
  username?: string;
  name?: string;
  label: string;
  avatarUrl?: string | null;
}

export type ArticleDraftSaveStatus =
  | "idle"
  | "saving"
  | "conflict"
  | "unavailable";

export interface ArticleComposerContextValue {
  // Draft data
  draftUuid: string;
  existingDraft: boolean;
  draftDataLoaded: Accessor<boolean>;
  draft: Accessor<
    | {
        id: string;
        uuid: string;
        title: string;
        content: string;
        tags: readonly string[];
        contentHtml?: string | null;
        revision: number;
        accountId: string;
        accountKind: "personal" | "organization";
        creatorId?: string | null;
      }
    | undefined
  >;

  // Form state (read)
  title: Accessor<string>;
  content: Accessor<string>;
  tags: Accessor<string[]>;
  slug: Accessor<string>;
  language: Accessor<Intl.Locale | undefined>;
  quotePolicy: Accessor<QuotePolicy>;
  publishActingAccountKey: Accessor<string>;
  allowLlmTranslation: Accessor<boolean>;
  isDirty: Accessor<boolean>;
  isPublishing: Accessor<boolean>;
  showPreview: Accessor<boolean>;
  previewHtml: Accessor<string>;

  // Draft workspace state
  workspaceKey: Accessor<string>;
  setWorkspaceKey: (value: string) => void;
  workspaceOptions: Accessor<ArticleDraftWorkspaceOption[]>;
  workspaceLocked: Accessor<boolean>;
  moveTargets: Accessor<
    readonly { id: string; username: string; name: string }[]
  >;
  moveToOrganization: (organizationAccountId: string) => void;

  // Concurrency state
  saveStatus: Accessor<ArticleDraftSaveStatus>;
  conflictRevision: Accessor<number | undefined>;
  overwriteWithLocal: () => void;
  discardAndReload: () => void;
  ensureDraft: () => Promise<{ id: string; revision: number } | undefined>;

  // Attribution (organization workspaces)
  showPersonalAuthor: Accessor<boolean>;
  setShowPersonalAuthor: (value: boolean) => void;

  // Form state (write)
  setTitle: (v: string) => void;
  setContent: (v: string) => void;
  setTags: (v: string[]) => void;
  setSlug: (v: string) => void;
  setLanguage: (locale?: Intl.Locale) => void;
  setQuotePolicy: (v: QuotePolicy) => void;
  setPublishActingAccountKey: (v: string) => void;
  setAllowLlmTranslation: (v: boolean) => void;
  setIsPublishing: (v: boolean) => void;
  setShowPreview: (v: boolean) => void;

  // Actions
  handleSave: (e?: Event, silent?: boolean, afterSave?: () => void) => void;
  handlePublish: (e?: Event) => void;
  publishArticleAnyway: () => void;
  saveAsNoteDraft: (replaceExisting?: boolean) => void;
  handleDelete: () => void;
  /**
   * Advance from the writing stage to the publish-settings stage, persisting any
   * unsaved changes first so the draft exists and its `id` is available.
   */
  goToPublishSettings: () => void;

  // Loading states
  isSaving: Accessor<boolean>;
  isPublishingMutation: Accessor<boolean>;
  isDeleting: Accessor<boolean>;
  isMoving: Accessor<boolean>;
  showShortArticleSuggestion: Accessor<boolean>;
  setShowShortArticleSuggestion: (v: boolean) => void;
  showReplaceNoteDraftConfirm: Accessor<boolean>;
  setShowReplaceNoteDraftConfirm: (v: boolean) => void;
}

const ArticleComposerContext = createContext<ArticleComposerContextValue>();

type DraftState = NonNullable<ReturnType<ArticleComposerContextValue["draft"]>>;

// --- Provider ---

export const ArticleComposerProvider: ParentComponent<ArticleComposerProps> = (
  props,
) => {
  const { t, i18n } = useLingui();
  const actingAccount = useActingAccount();
  const navigate = useNavigate();
  const params = useParams();
  const env = useRelayEnvironment();
  const initialExistingDraftUuid = untrack(() => props.draftUuid);
  const draftUuid = (initialExistingDraftUuid ??
    crypto.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`;

  // Draft loading
  const draftData = initialExistingDraftUuid
    ? createStablePreloadedQuery<ArticleComposerContextDraftQueryType>(
        ArticleComposerDraftQuery,
        () =>
          loadQuery<ArticleComposerContextDraftQueryType>(
            env(),
            ArticleComposerDraftQuery,
            {
              uuid: initialExistingDraftUuid as `${string}-${string}-${string}-${string}-${string}`,
            },
          ),
      )
    : undefined;

  const loadedDraft = createMemo<DraftState | undefined>(() => {
    if (!initialExistingDraftUuid || !draftData) return undefined;
    const raw = draftData()?.articleDraft;
    if (!raw) return undefined;
    return {
      id: raw.id,
      uuid: raw.uuid,
      title: raw.title,
      content: raw.content,
      tags: raw.tags,
      contentHtml: raw.contentHtml,
      revision: raw.revision,
      accountId: raw.account.id,
      accountKind:
        raw.account.kind === "ORGANIZATION" ? "organization" : "personal",
      creatorId: raw.creator?.id ?? null,
    };
  });
  const [savedDraft, setSavedDraft] = createSignal<DraftState | undefined>();
  const draft = createMemo(() => savedDraft() ?? loadedDraft());

  const draftDataLoaded = createMemo(() => {
    // When editing an existing draft the Relay store starts empty on the
    // client, so draftData() is initially undefined there while the server
    // already has the data. Returning false on the server for this case
    // keeps the initial render consistent (both sides show the loading
    // state) and avoids a hydration mismatch.
    if (initialExistingDraftUuid && isServer) return false;
    return !initialExistingDraftUuid || !!draftData?.();
  });

  // Form state
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [slug, setSlug] = createSignal("");
  const [language, setLanguageSignal] = createSignal<Intl.Locale | undefined>(
    new Intl.Locale(i18n.locale),
  );
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy>("EVERYONE");
  const [publishActingAccountKey, setPublishActingAccountKey] = createSignal(
    PERSONAL_COMPOSE_ACCOUNT_KEY,
  );
  const [allowLlmTranslation, setAllowLlmTranslation] = createSignal(true);
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
  const [manualSlugChange, setManualSlugChange] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [showShortArticleSuggestion, setShowShortArticleSuggestion] =
    createSignal(false);
  const [showReplaceNoteDraftConfirm, setShowReplaceNoteDraftConfirm] =
    createSignal(false);
  const noteDraftSyncOrigin = Symbol("ArticleComposer");

  // Preview state
  const [showPreview, setShowPreview] = createSignal(false);
  const [previewHtml, setPreviewHtml] = createSignal("");

  // Draft workspace state. The workspace is chosen before the first save and
  // frozen once a draft exists; ownership only changes through an explicit
  // move to an organization.
  const initialWorkspaceKey = untrack(() =>
    props.workspaceKind === "organization" && props.workspaceAccountId != null
      ? `organization:${props.workspaceAccountId}`
      : "personal",
  );
  const [workspaceKey, setWorkspaceKeySignal] =
    createSignal(initialWorkspaceKey);
  const [workspaceFrozen, setWorkspaceFrozen] = createSignal(
    initialExistingDraftUuid != null,
  );
  const [saveStatus, setSaveStatus] =
    createSignal<ArticleDraftSaveStatus>("idle");
  const [conflictRevision, setConflictRevision] = createSignal<number>();
  const [showPersonalAuthor, setShowPersonalAuthor] = createSignal(false);

  const workspaceOptions = createMemo<ArticleDraftWorkspaceOption[]>(() => {
    const options: ArticleDraftWorkspaceOption[] = [];
    const personal = actingAccount.personalAccount();
    if (personal != null) {
      options.push({
        value: "personal",
        username: personal.username,
        name: personal.name || personal.username,
        label: `${personal.name || personal.username} (@${personal.username})`,
        avatarUrl: personal.avatarUrl,
      });
    }
    for (const membership of actingAccount.organizations()) {
      const organization = membership.organization;
      options.push({
        value: `organization:${organization.id}`,
        accountId: organization.id,
        username: organization.username,
        name: organization.name || organization.username,
        label: `${organization.name || organization.username} (@${organization.username})`,
        avatarUrl: organization.avatarUrl,
      });
    }
    return options;
  });

  const workspaceAccountId = createMemo<string | undefined>(() => {
    const match = /^organization:(.+)$/.exec(workspaceKey());
    return match?.[1];
  });

  const workspaceLocked = createMemo(
    () => workspaceFrozen() || draft() != null,
  );

  const setWorkspaceKey = (value: string) => {
    if (workspaceLocked()) return;
    setWorkspaceKeySignal(value);
  };

  const moveTargets = createMemo(() =>
    actingAccount.organizations().map((membership) => ({
      id: membership.organization.id,
      username: membership.organization.username,
      name: membership.organization.name || membership.organization.username,
    })),
  );

  const ownerConnectionAccountId = () => {
    const current = draft();
    if (current != null) return current.accountId;
    return workspaceAccountId() ?? props.viewerId;
  };

  const draftConnections = () => {
    const ownerId = ownerConnectionAccountId();
    if (ownerId == null) return [];
    const connections = [
      ConnectionHandler.getConnectionID(
        ownerId,
        "draftsPaginationFragment_articleDrafts",
      ),
    ];
    if (workspaceKey() === "personal" && props.viewerId != null) {
      connections.push(
        ConnectionHandler.getConnectionID(
          props.viewerId,
          "SignedAccount_articleDrafts",
        ),
        ConnectionHandler.getConnectionID(
          props.viewerId,
          "FloatingComposeButton_articleDrafts",
        ),
      );
    }
    return connections;
  };

  // Mutations
  const [saveDraft, isSaving] =
    createMutation<ArticleComposerContextSaveMutation>(
      SaveArticleDraftMutation,
    );
  const [publishDraft, isPublishingMutation] =
    createMutation<ArticleComposerContextPublishMutation>(
      PublishArticleDraftMutation,
    );
  const [deleteDraft, isDeleting] =
    createMutation<ArticleComposerContextDeleteMutation>(
      DeleteArticleDraftMutation,
    );
  const [moveDraft, isMoving] =
    createMutation<ArticleComposerContextMoveMutation>(
      MoveArticleDraftToOrganizationMutation,
    );

  const markUnavailable = () => {
    if (saveStatus() !== "conflict") setSaveStatus("unavailable");
  };

  // Assigned once `createDraftOnce` is defined below. It keeps `submitSave` and
  // image uploads on one shared creation path, so the first autosave and a
  // concurrent upload cannot both try to create the same draft.
  let ensureDraftImpl: (() => Promise<CreateDraftOutcome>) | undefined;

  // --- Handlers ---

  const stripUploadingPlaceholders = (value: string) =>
    value.replace(/!\[Uploading [^\]]*\]\(uploading\)/g, "");

  const submitSave = (
    submittedDraft: DraftFormSnapshot,
    initialSubmittedForm: DraftFormSnapshot,
    options: { silent: boolean; afterSave?: () => void; revision?: number },
  ) => {
    const current = draft();
    if (current == null && options.revision == null) {
      // Freeze the workspace before dispatching, so the selection cannot change
      // under the in-flight creation, and funnel through the single creation
      // path shared with image uploads.
      setWorkspaceFrozen(true);
      void (
        ensureDraftImpl?.() ?? Promise.resolve({ status: "failed" } as const)
      ).then((outcome) => {
        if (outcome.status === "ok") {
          submitSave(submittedDraft, initialSubmittedForm, options);
        } else if (outcome.status === "conflict") {
          // The create committed but its response was lost: keep local text
          // and let the user resolve it like any other conflict.
          setConflictRevision(outcome.currentRevision);
          setSaveStatus("conflict");
          setIsDirty(true);
          showToast({
            title: t`Error`,
            description: t`This draft was changed by someone else. Your edits are kept locally; choose how to resolve the conflict.`,
            variant: "error",
          });
        } else if (outcome.status === "forbidden") {
          // Nothing was created, so release the lock and let the user pick
          // another workspace.
          setWorkspaceFrozen(false);
          setSaveStatus("idle");
          showToast({
            title: t`Error`,
            description: t`You no longer have posting permission for this draft's workspace.`,
            variant: "error",
          });
        } else {
          setSaveStatus("idle");
          showToast({
            title: t`Error`,
            description: t`Failed to save the draft.`,
            variant: "error",
          });
        }
      });
      return;
    }
    const input =
      current != null
        ? {
            id: current.id,
            revision: options.revision ?? current.revision,
            title: submittedDraft.title,
            content: submittedDraft.content,
            tags: submittedDraft.tags,
          }
        : options.revision != null
          ? {
              // A create whose response was lost: retry as an update of the
              // known revision so the existing row is adopted, not duplicated.
              uuid: draftUuid,
              revision: options.revision,
              title: submittedDraft.title,
              content: submittedDraft.content,
              tags: submittedDraft.tags,
            }
          : {
              uuid: draftUuid,
              actingAccountId: workspaceAccountId(),
              title: submittedDraft.title,
              content: submittedDraft.content,
              tags: submittedDraft.tags,
            };

    setSaveStatus("saving");
    saveDraft({
      variables: {
        input,
        connections: draftConnections(),
      },
      onCompleted(response) {
        if (
          response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
        ) {
          const saved = response.saveArticleDraft.draft;
          const currentForm = createDraftFormSnapshot(
            title(),
            content(),
            tags(),
          );
          const savedForm = createDraftFormSnapshot(
            saved.title,
            saved.content,
            saved.tags,
          );
          const { formReconciled, baseline } = reconcileDraftSaveResponse(
            currentForm,
            initialSubmittedForm,
            savedForm,
          );

          setSavedDraft({
            id: saved.id,
            uuid: saved.uuid,
            title: baseline.title,
            content: baseline.content,
            tags: [...baseline.tags],
            contentHtml: saved.contentHtml,
            revision: saved.revision,
            accountId: saved.account.id,
            accountKind:
              saved.account.kind === "ORGANIZATION"
                ? "organization"
                : "personal",
            creatorId: saved.creator?.id ?? null,
          });
          setWorkspaceFrozen(true);
          setWorkspaceKeySignal(
            saved.account.kind === "ORGANIZATION"
              ? `organization:${saved.account.id}`
              : "personal",
          );
          setConflictRevision(undefined);
          setSaveStatus("idle");

          if (formReconciled) {
            setIsDirty(false);
          } else {
            setIsDirty(true);
          }

          if (saved.contentHtml) {
            setPreviewHtml(saved.contentHtml);
          }

          if (!options.silent) {
            showToast({
              title: t`Success`,
              description: t`Draft saved`,
              variant: "success",
            });
          }
          if (formReconciled) {
            props.onSaved?.(saved.id, saved.uuid, saved.account.username);
            // Only continue (e.g. advance to publish, or publish now) when the
            // form still matches what was submitted or has converged to the
            // saved response. Otherwise the user has newer unsaved changes,
            // so skip the follow-up rather than acting on a stale draft.
            options.afterSave?.();
          }
        } else if (
          response.saveArticleDraft.__typename === "ArticleDraftConflictError"
        ) {
          // Keep the local text and require an explicit resolution; autosave is
          // paused while the save status is `conflict`.
          setConflictRevision(response.saveArticleDraft.currentRevision);
          setSaveStatus("conflict");
          setIsDirty(true);
          showToast({
            title: t`Error`,
            description: t`This draft was changed by someone else. Your edits are kept locally; choose how to resolve the conflict.`,
            variant: "error",
          });
        } else if (
          response.saveArticleDraft.__typename === "InvalidInputError"
        ) {
          setSaveStatus("idle");
          if (
            response.saveArticleDraft.inputPath === "id" ||
            response.saveArticleDraft.inputPath === "uuid"
          ) {
            markUnavailable();
          }
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.saveArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.saveArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          setSaveStatus("idle");
          showToast({
            title: t`Error`,
            description: t`You must be signed in to save a draft`,
            variant: "error",
          });
        } else if (
          response.saveArticleDraft.__typename === "OrganizationPermissionError"
        ) {
          // Reachable only from the create path: no draft exists yet, so leave
          // the editor editable and let the user pick another workspace.
          setSaveStatus("idle");
          showToast({
            title: t`Error`,
            description: t`You no longer have posting permission for this draft's workspace.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setSaveStatus("idle");
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  const handleSave = (e?: Event, silent?: boolean, afterSave?: () => void) => {
    e?.preventDefault();

    if (saveStatus() === "conflict") {
      showToast({
        title: t`Error`,
        description: t`Resolve the conflicting changes before saving.`,
        variant: "error",
      });
      return;
    }
    if (saveStatus() === "unavailable") {
      showToast({
        title: t`Error`,
        description: t`This draft is no longer available or you no longer have access.`,
        variant: "error",
      });
      return;
    }

    if (!title().trim()) {
      if (!silent) {
        showToast({
          title: t`Error`,
          description: t`Title cannot be empty`,
          variant: "error",
        });
      }
      return;
    }

    const initialSubmittedForm = createDraftFormSnapshot(
      title(),
      content(),
      tags(),
    );
    const submittedDraft = createDraftSaveInput(initialSubmittedForm);
    submitSave(
      {
        ...submittedDraft,
        content: stripUploadingPlaceholders(submittedDraft.content),
      },
      initialSubmittedForm,
      { silent: silent ?? false, afterSave },
    );
  };

  // Create the draft on demand so every first-save path (manual save,
  // autosave, image upload, publish) funnels through one operation. The
  // workspace and UUID are frozen first, and an ambiguous failure keeps them
  // frozen instead of blindly retrying, which could resurrect a deleted draft.
  type CreateDraftOutcome =
    | { status: "ok"; id: string; revision: number }
    | { status: "conflict"; currentRevision: number }
    | { status: "forbidden" }
    | { status: "failed" };

  let createDraftPromise: Promise<CreateDraftOutcome> | undefined;
  const createDraftOnce = async (): Promise<CreateDraftOutcome> => {
    const existing = draft();
    if (existing != null) {
      return { status: "ok", id: existing.id, revision: existing.revision };
    }
    if (createDraftPromise != null) return await createDraftPromise;
    setWorkspaceFrozen(true);
    createDraftPromise = new Promise<CreateDraftOutcome>((resolve) => {
      const initialForm = untrack(() =>
        createDraftFormSnapshot(title(), content(), tags()),
      );
      const submitted = createDraftSaveInput(initialForm);
      saveDraft({
        variables: {
          input: {
            uuid: draftUuid,
            actingAccountId: untrack(() => workspaceAccountId()),
            title: submitted.title,
            content: stripUploadingPlaceholders(submitted.content),
            tags: submitted.tags,
          },
          connections: untrack(() => draftConnections()),
        },
        onCompleted(response) {
          if (
            response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
          ) {
            const saved = response.saveArticleDraft.draft;
            setSavedDraft({
              id: saved.id,
              uuid: saved.uuid,
              title: submitted.title,
              content: submitted.content,
              tags: [...submitted.tags],
              contentHtml: saved.contentHtml,
              revision: saved.revision,
              accountId: saved.account.id,
              accountKind:
                saved.account.kind === "ORGANIZATION"
                  ? "organization"
                  : "personal",
              creatorId: saved.creator?.id ?? null,
            });
            setWorkspaceFrozen(true);
            setWorkspaceKeySignal(
              saved.account.kind === "ORGANIZATION"
                ? `organization:${saved.account.id}`
                : "personal",
            );
            resolve({ status: "ok", id: saved.id, revision: saved.revision });
          } else if (
            response.saveArticleDraft.__typename === "ArticleDraftConflictError"
          ) {
            resolve({
              status: "conflict",
              currentRevision: response.saveArticleDraft.currentRevision,
            });
          } else if (
            response.saveArticleDraft.__typename ===
            "OrganizationPermissionError"
          ) {
            resolve({ status: "forbidden" });
          } else {
            resolve({ status: "failed" });
          }
        },
        onError() {
          resolve({ status: "failed" });
        },
      });
    });
    const outcome = await createDraftPromise;
    if (outcome.status !== "ok") createDraftPromise = undefined;
    return outcome;
  };
  ensureDraftImpl = createDraftOnce;

  const ensureDraft = async (): Promise<
    { id: string; revision: number } | undefined
  > => {
    const outcome = await createDraftOnce();
    return outcome.status === "ok"
      ? { id: outcome.id, revision: outcome.revision }
      : undefined;
  };

  const handlePublish = (e?: Event) => {
    e?.preventDefault();

    if (shouldSuggestNoteForArticle(content())) {
      setShowShortArticleSuggestion(true);
      return;
    }

    publishArticleAnyway();
  };

  const publishArticleAnyway = () => {
    if (!slug().trim()) {
      showToast({
        title: t`Error`,
        description: t`Slug cannot be empty`,
        variant: "error",
      });
      return;
    }

    if (!draft()?.id) {
      showToast({
        title: t`Error`,
        description: t`Draft must be saved before publishing`,
        variant: "error",
      });
      return;
    }

    // Tags are only persisted via `saveDraft` (the publish input doesn't carry
    // them) and Stage 2 pauses autosave, so flush any pending edits first, then
    // publish once the save lands.
    if (isDirty()) {
      handleSave(undefined, true, publishNow);
    } else {
      publishNow();
    }
  };

  const getBrowserDraftStorage = getBrowserLocalStorage;

  const getRouteUsername = () => {
    const handle = params.handle;
    return handle == null ? null : decodeRouteParam(handle).substring(1);
  };

  const saveAsNoteDraft = (replaceExisting = false) => {
    // Note drafts are stored under the signed-in personal account, even when
    // the article belongs to an organization workspace.
    const username =
      actingAccount.personalAccount()?.username ?? getRouteUsername();
    if (username == null) {
      showToast({
        title: t`Error`,
        description: t`You must be signed in to save a draft`,
        variant: "error",
      });
      return;
    }

    const scope = { type: "new" } as const;
    const key = getNoteDraftStorageKey(username, scope);
    const storage = getBrowserDraftStorage();
    if (readNoteDraft(storage, key) != null && !replaceExisting) {
      setShowShortArticleSuggestion(false);
      setShowReplaceNoteDraftConfirm(true);
      return;
    }

    const result = writeNoteDraft(storage, key, scope, {
      content: buildNoteDraftContentFromArticle(title(), content()),
      language: language()?.baseName,
      visibility: "PUBLIC",
      quotePolicy: quotePolicy(),
      actingAccountKey:
        workspaceKey() === "personal"
          ? PERSONAL_COMPOSE_ACCOUNT_KEY
          : `${workspaceKey()}:only`,
      media: [],
      poll: {
        enabled: false,
        title: "",
        multiple: false,
        ends: "",
        options: [
          { localId: crypto.randomUUID(), title: "" },
          { localId: crypto.randomUUID(), title: "" },
        ],
      },
      updated: new Date().toISOString(),
    });

    if (result !== "ok") {
      showToast({
        title: t`Error`,
        description: t`Local draft could not be saved`,
        variant: "error",
      });
      return;
    }

    publishNoteDraftChange({ key, origin: noteDraftSyncOrigin });
    setIsDirty(false);
    setShowShortArticleSuggestion(false);
    setShowReplaceNoteDraftConfirm(false);
    showToast({
      title: t`Success`,
      description: t`Local draft saved`,
      variant: "success",
    });
    navigate("/feed?compose=note");
  };

  const publishNow = () => {
    const current = draft();
    if (current == null) return;
    const attribution =
      current.accountKind === "organization"
        ? showPersonalAuthor()
          ? { attributionMode: "ACTING_ACCOUNT_WITH_VIEWER" as const }
          : { attributionMode: "ACTING_ACCOUNT_ONLY" as const }
        : {};
    publishDraft({
      variables: {
        input: {
          id: current.id,
          slug: slug().trim(),
          language: language()?.baseName ?? i18n.locale,
          allowLlmTranslation: allowLlmTranslation(),
          quotePolicy: quotePolicy(),
          revision: current.revision,
          ...attribution,
        },
      },
      onCompleted(response) {
        if (
          response.publishArticleDraft.__typename ===
          "PublishArticleDraftPayload"
        ) {
          const articleUrl = response.publishArticleDraft.article.url!;
          const articlePath = new URL(articleUrl).pathname.replace(/\/$/, "");
          navigate(articlePath);
          setIsDirty(false);
          showToast({
            title: t`Article published`,
            description: t`View article analytics`,
            href: `${articlePath}/analytics`,
            variant: "success",
          });
        } else if (
          response.publishArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.publishArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.publishArticleDraft.__typename ===
          "ArticleDraftConflictError"
        ) {
          setConflictRevision(response.publishArticleDraft.currentRevision);
          setSaveStatus("conflict");
          showToast({
            title: t`Error`,
            description: t`This draft was changed by someone else. Reload it before publishing.`,
            variant: "error",
          });
        } else if (
          response.publishArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to publish an article`,
            variant: "error",
          });
        } else if (
          response.publishArticleDraft.__typename ===
          "OrganizationPermissionError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You no longer have posting permission for this draft's workspace.`,
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

  const overwriteWithLocal = () => {
    const revision = conflictRevision();
    if (revision == null) return;
    const form = createDraftFormSnapshot(title(), content(), tags());
    const submitted = createDraftSaveInput(form);
    submitSave(
      {
        ...submitted,
        content: stripUploadingPlaceholders(submitted.content),
      },
      form,
      { silent: false, revision },
    );
  };

  const discardAndReload = () => {
    const current = draft();
    const uuidToLoad = current?.uuid ?? draftUuid;
    setSaveStatus("saving");
    fetchQuery<ArticleComposerContextDraftQueryType>(
      env(),
      ArticleComposerDraftQuery,
      {
        uuid: uuidToLoad as `${string}-${string}-${string}-${string}-${string}`,
      },
    ).subscribe({
      next(value) {
        const raw = value.articleDraft;
        if (raw == null) {
          setSaveStatus("unavailable");
          return;
        }
        setSavedDraft({
          id: raw.id,
          uuid: raw.uuid,
          title: raw.title,
          content: raw.content,
          tags: raw.tags,
          contentHtml: raw.contentHtml,
          revision: raw.revision,
          accountId: raw.account.id,
          accountKind:
            raw.account.kind === "ORGANIZATION" ? "organization" : "personal",
          creatorId: raw.creator?.id ?? null,
        });
        setTitle(raw.title);
        setContent(raw.content);
        setTags([...raw.tags]);
        if (raw.contentHtml) setPreviewHtml(raw.contentHtml);
        setWorkspaceKeySignal(
          raw.account.kind === "ORGANIZATION"
            ? `organization:${raw.account.id}`
            : "personal",
        );
        setWorkspaceFrozen(true);
        setIsDirty(false);
        setConflictRevision(undefined);
        setSaveStatus("idle");
      },
      error() {
        setSaveStatus("conflict");
        showToast({
          title: t`Error`,
          description: t`Failed to load the latest draft.`,
          variant: "error",
        });
      },
    });
  };

  const moveToOrganization = (organizationAccountId: string) => {
    const initialDraft = draft();
    if (initialDraft == null) {
      showToast({
        title: t`Error`,
        description: t`Save the draft before moving it.`,
        variant: "error",
      });
      return;
    }
    if (isDirty()) {
      showToast({
        title: t`Error`,
        description: t`Save your changes before moving the draft.`,
        variant: "error",
      });
      return;
    }
    if (saveStatus() !== "idle") {
      showToast({
        title: t`Error`,
        description: t`Resolve the conflicting changes before moving the draft.`,
        variant: "error",
      });
      return;
    }
    moveDraft({
      variables: {
        input: {
          id: initialDraft.id,
          organizationAccountId,
          revision: initialDraft.revision,
        },
      },
      onCompleted(response) {
        if (
          response.moveArticleDraftToOrganization.__typename ===
          "MoveArticleDraftToOrganizationPayload"
        ) {
          const moved = response.moveArticleDraftToOrganization.draft;
          setSavedDraft({
            ...initialDraft,
            accountId: moved.account.id,
            accountKind: "organization",
            revision: moved.revision,
          });
          setWorkspaceKeySignal(`organization:${moved.account.id}`);
          setWorkspaceFrozen(true);
          // Relay does not relocate a normalized node between connections, so
          // move the edge explicitly: drop it from the personal lists and add
          // it to the organization list if that connection is loaded.
          const viewerId = untrack(() => props.viewerId);
          commitLocalUpdate(env(), (store) => {
            const sourceConnections = [
              ConnectionHandler.getConnectionID(
                initialDraft.accountId,
                "draftsPaginationFragment_articleDrafts",
              ),
            ];
            if (viewerId != null && initialDraft.accountId === viewerId) {
              sourceConnections.push(
                ConnectionHandler.getConnectionID(
                  viewerId,
                  "SignedAccount_articleDrafts",
                ),
                ConnectionHandler.getConnectionID(
                  viewerId,
                  "FloatingComposeButton_articleDrafts",
                ),
              );
            }
            for (const connectionId of sourceConnections) {
              const connection = store.get(connectionId);
              if (connection != null) {
                ConnectionHandler.deleteNode(connection, initialDraft.id);
              }
            }
            const destination = store.get(
              ConnectionHandler.getConnectionID(
                moved.account.id,
                "draftsPaginationFragment_articleDrafts",
              ),
            );
            const node = store.get(initialDraft.id);
            if (destination != null && node != null) {
              const edge = ConnectionHandler.createEdge(
                store,
                destination,
                node,
                "AccountArticleDraftsConnectionEdge",
              );
              ConnectionHandler.insertEdgeAfter(destination, edge);
            }
          });
          const target = moveTargets().find((o) => o.id === moved.account.id);
          if (target != null) {
            navigate(`/@${target.username}/drafts/${initialDraft.uuid}`, {
              replace: true,
            });
          }
          showToast({
            title: t`Success`,
            description: t`Draft moved to the organization. Members can now view and edit it.`,
            variant: "success",
          });
        } else if (
          response.moveArticleDraftToOrganization.__typename ===
          "ArticleDraftConflictError"
        ) {
          setConflictRevision(
            response.moveArticleDraftToOrganization.currentRevision,
          );
          setSaveStatus("conflict");
          showToast({
            title: t`Error`,
            description: t`This draft was changed by someone else. Reload it before moving it.`,
            variant: "error",
          });
        } else if (
          response.moveArticleDraftToOrganization.__typename ===
          "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.moveArticleDraftToOrganization.inputPath}`,
            variant: "error",
          });
        } else if (
          response.moveArticleDraftToOrganization.__typename ===
          "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to move a draft`,
            variant: "error",
          });
        } else if (
          response.moveArticleDraftToOrganization.__typename ===
          "OrganizationPermissionError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You no longer have posting permission for that organization.`,
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

  const handleDelete = () => {
    if (!draft()?.id) {
      showToast({
        title: t`Error`,
        description: t`No draft to delete`,
        variant: "error",
      });
      return;
    }

    if (
      !confirm(
        t`Are you sure you want to delete this draft? This action cannot be undone.`,
      )
    ) {
      return;
    }

    deleteDraft({
      variables: {
        input: {
          id: draft()!.id,
          revision: draft()!.revision,
        },
        connections: draftConnections(),
      },
      onCompleted(response) {
        if (
          response.deleteArticleDraft.__typename === "DeleteArticleDraftPayload"
        ) {
          setIsDirty(false);
          navigate(`..`);
          showToast({
            title: t`Success`,
            description: t`Draft deleted`,
            variant: "success",
          });
        } else if (
          response.deleteArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description: t`Invalid input: ${response.deleteArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.deleteArticleDraft.__typename === "ArticleDraftConflictError"
        ) {
          setConflictRevision(response.deleteArticleDraft.currentRevision);
          setSaveStatus("conflict");
          showToast({
            title: t`Error`,
            description: t`This draft was changed by someone else. Reload it before deleting.`,
            variant: "error",
          });
        } else if (
          response.deleteArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to delete a draft`,
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

  const goToPublishSettings = () => {
    if (!title().trim()) {
      showToast({
        title: t`Error`,
        description: t`Title cannot be empty`,
        variant: "error",
      });
      return;
    }

    if (isDirty()) {
      handleSave(undefined, true, () => setIsPublishing(true));
    } else {
      setIsPublishing(true);
    }
  };

  // --- Effects ---

  const [hydratedDraft, setHydratedDraft] = createSignal(false);

  // Populate form when the initial draft loads. Later save responses update
  // the saved baseline, but must not overwrite text the user typed while the
  // request was in flight.
  createEffect(() => {
    const currentDraft = loadedDraft();
    if (currentDraft && !hydratedDraft()) {
      setSavedDraft(currentDraft);
      setTitle(currentDraft.title);
      setContent(currentDraft.content);
      setTags([...currentDraft.tags]);
      // Seed the preview so an existing draft shows rendered content
      // immediately (the desktop side-by-side preview otherwise stays empty
      // until the first autosave).
      if (currentDraft.contentHtml) setPreviewHtml(currentDraft.contentHtml);
      setWorkspaceKeySignal(
        currentDraft.accountKind === "organization"
          ? `organization:${currentDraft.accountId}`
          : "personal",
      );
      setWorkspaceFrozen(true);
      setHydratedDraft(true);
    }
  });

  // An existing draft that fails to load (deleted, or access revoked while the
  // editor was open) becomes unavailable. It must not be treated as a new
  // draft, or a later save could recreate it.
  createEffect(() => {
    if (
      initialExistingDraftUuid != null &&
      draftDataLoaded() &&
      draft() == null
    ) {
      setSaveStatus("unavailable");
    }
  });

  // Auto-detect language from content
  createEffect(() => {
    if (manualLanguageChange()) return;

    const text = content().trim();
    const detectedLang = detectLanguage({
      text,
      acceptLanguage: null,
    });

    if (detectedLang) {
      setLanguageSignal(new Intl.Locale(detectedLang));
    }
  });

  createEffect(
    on(
      () => actingAccount.defaultComposeAccountKey(),
      (defaultKey) => setPublishActingAccountKey(defaultKey),
    ),
  );

  createEffect(() => {
    if (
      publishActingAccountKey() !== PERSONAL_COMPOSE_ACCOUNT_KEY &&
      actingAccount.composeInputForKey(publishActingAccountKey())
        .actingAccountId == null
    ) {
      setPublishActingAccountKey(actingAccount.defaultComposeAccountKey());
    }
  });

  // Auto-generate slug from title (only while user hasn't manually touched it)
  createEffect(() => {
    const titleValue = title();
    if (titleValue && !manualSlugChange()) {
      const autoSlug = titleValue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 128);
      setSlug(autoSlug);
    }
  });

  const handleSetSlug = (v: string) => {
    setManualSlugChange(true);
    setSlug(v);
  };

  // Language setter that also marks manual change
  const setLanguage = (locale?: Intl.Locale) => {
    setLanguageSignal(locale);
    setManualLanguageChange(true);
  };

  // Auto-save + dirty tracking
  const { isDirty, setIsDirty } = useAutoSave({
    title,
    content,
    tags,
    draft,
    save: (silent) => handleSave(undefined, silent),
    isSaving,
    isPublishing,
    saveBlocked: () => saveStatus() !== "idle",
  });

  // Navigation guards
  useUnsavedGuard(isDirty);

  // --- Context value ---

  const contextValue: ArticleComposerContextValue = {
    draftUuid,
    existingDraft: initialExistingDraftUuid != null,
    draftDataLoaded,
    draft,

    title,
    content,
    tags,
    slug,
    language,
    quotePolicy,
    publishActingAccountKey,
    allowLlmTranslation,
    isDirty,
    isPublishing,
    showPreview,
    previewHtml,

    workspaceKey,
    setWorkspaceKey,
    workspaceOptions,
    workspaceLocked,
    moveTargets,
    moveToOrganization,

    saveStatus,
    conflictRevision,
    overwriteWithLocal,
    discardAndReload,
    ensureDraft,

    showPersonalAuthor,
    setShowPersonalAuthor,

    setTitle,
    setContent,
    setTags,
    setSlug: handleSetSlug,
    setLanguage,
    setQuotePolicy,
    setPublishActingAccountKey,
    setAllowLlmTranslation,
    setIsPublishing,
    setShowPreview,

    handleSave,
    handlePublish,
    publishArticleAnyway,
    saveAsNoteDraft,
    handleDelete,
    goToPublishSettings,

    isSaving,
    isPublishingMutation,
    isDeleting,
    isMoving,
    showShortArticleSuggestion,
    setShowShortArticleSuggestion,
    showReplaceNoteDraftConfirm,
    setShowReplaceNoteDraftConfirm,
  };

  return (
    <ArticleComposerContext.Provider value={contextValue}>
      {props.children}
    </ArticleComposerContext.Provider>
  );
};

// --- Hook ---

export function useArticleComposer(): ArticleComposerContextValue {
  const context = useContext(ArticleComposerContext);
  if (!context) {
    throw new Error(
      "useArticleComposer must be used within ArticleComposerProvider",
    );
  }
  return context;
}

import IconLoader2 from "~icons/lucide/loader-2";
import { createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "~/components/ui/button.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import { getSupportedImageContentType } from "~/lib/supportedImageFile.ts";
import { uploadMediumFile } from "~/lib/uploadMediumWithProgress.ts";
import { attachArticleDraftMediumOnServer } from "~/lib/uploadImage.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";
import { ComposerActionBar } from "./shared/ComposerActionBar.tsx";
import { ComposerEditorPanes } from "./shared/ComposerEditorPanes.tsx";
import { ComposerTitleField } from "./shared/ComposerTitleField.tsx";

export function ArticleComposerWriteStep() {
  const { t } = useLingui();
  const ctx = useArticleComposer();
  const navigate = useNavigate();

  const handleImageUpload = async (file: File): Promise<{ url: string }> => {
    try {
      const contentType = getSupportedImageContentType(file);
      if (contentType == null) throw new Error(t`Failed to upload image`);
      // Media can only be attached to an existing draft, so make sure one
      // exists (through the single creation path) before uploading.
      const ensured = await ctx.ensureDraft();
      if (ensured == null) throw new Error(t`Failed to upload image`);
      const result = await uploadMediumFile(file, contentType).result;
      const key = await attachArticleDraftMediumOnServer(
        ctx.draftUuid,
        result.uuid,
      );
      return { url: `hp-medium:${key}` };
    } catch (error) {
      showToast({
        title: t`Error`,
        description:
          error instanceof Error ? error.message : t`Failed to upload image`,
        variant: "error",
      });
      throw error;
    }
  };

  const handleShowPreviewChange = (next: boolean) => {
    ctx.setShowPreview(next);
    if (next && ctx.content().trim() && (ctx.isDirty() || !ctx.previewHtml())) {
      ctx.handleSave(undefined, true);
    }
  };

  return (
    <>
      <DraftWorkspaceBar />
      <ComposerTitleField
        value={ctx.title()}
        onInput={ctx.setTitle}
        placeholder={t`Title`}
      />

      <ComposerEditorPanes
        content={ctx.content()}
        onContentInput={ctx.setContent}
        contentPlaceholder={t`Write your article here. You can use Markdown. Your article will be automatically saved as a draft while you're writing.`}
        onImageUpload={handleImageUpload}
        previewHtml={ctx.previewHtml()}
        previewPending={ctx.isSaving()}
        previewEmptyLabel={t`Start writing to see a preview.`}
        showPreview={ctx.showPreview()}
        onShowPreviewChange={handleShowPreviewChange}
      />

      <ComposerActionBar
        start={
          <Button type="button" variant="ghost" onClick={() => navigate("..")}>
            {t`Back`}
          </Button>
        }
        end={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={ctx.handleSave}
              disabled={
                ctx.isSaving() || !ctx.isDirty() || ctx.saveStatus() !== "idle"
              }
            >
              <Show when={ctx.isSaving()}>
                <IconLoader2 class="size-4 animate-spin" aria-hidden="true" />
              </Show>
              {ctx.isSaving() ? t`Saving…` : t`Save draft`}
            </Button>
            <Button
              type="button"
              onClick={ctx.goToPublishSettings}
              disabled={
                !ctx.draft()?.id ||
                ctx.isSaving() ||
                ctx.saveStatus() !== "idle"
              }
            >
              {t`Publish`}
            </Button>
          </>
        }
      />
    </>
  );
}

function DraftWorkspaceBar() {
  const { t } = useLingui();
  const ctx = useArticleComposer();
  const [moveOpen, setMoveOpen] = createSignal(false);

  const currentLabel = () =>
    ctx.workspaceOptions().find((option) => option.value === ctx.workspaceKey())
      ?.label ?? t`Personal`;
  const canMove = () =>
    ctx.draft()?.accountKind === "personal" && ctx.moveTargets().length > 0;
  const options = () => ctx.workspaceOptions();
  const organizationWorkspace = () => ctx.workspaceKey() !== "personal";

  return (
    <div class="shrink-0 border-b px-4 py-2 sm:px-6">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Show
          when={!ctx.workspaceLocked() && options().length > 1}
          fallback={
            <span class="text-sm text-muted-foreground">
              {t`Draft workspace:`}{" "}
              <span class="font-medium text-foreground">{currentLabel()}</span>
            </span>
          }
        >
          <Label class="text-sm text-muted-foreground">{t`Draft workspace`}</Label>
          <Select
            value={ctx.workspaceKey()}
            onChange={(value) => ctx.setWorkspaceKey(value ?? "personal")}
            options={options().map((option) => option.value)}
            itemComponent={(itemProps) => (
              <SelectItem item={itemProps.item}>
                {
                  options().find(
                    (option) => option.value === itemProps.item.rawValue,
                  )?.label
                }
              </SelectItem>
            )}
          >
            <SelectTrigger
              aria-label={t`Draft workspace`}
              aria-describedby={
                organizationWorkspace() ? "draft-workspace-hint" : undefined
              }
              class="w-full text-left sm:w-[340px]"
            >
              <SelectValue<string>>
                {(state) => (
                  <span class="truncate">
                    {
                      options().find(
                        (option) => option.value === state.selectedOption(),
                      )?.label
                    }
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Show>
        <Show when={ctx.workspaceLocked() && canMove()}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMoveOpen(true)}
          >
            {t`Move to organization`}
          </Button>
        </Show>
        <Show when={organizationWorkspace()}>
          <p
            id="draft-workspace-hint"
            class="hidden text-sm leading-6 text-muted-foreground sm:block"
          >
            {t`Members with posting permission can view and edit this draft.`}
          </p>
        </Show>
      </div>
      <AlertDialog open={moveOpen()} onOpenChange={setMoveOpen}>
        <AlertDialogContent class="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Move to organization`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`The organization's members with posting permission will gain access to this draft. Move it back afterward is not supported.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div class="flex flex-col gap-2">
            <For each={ctx.moveTargets()}>
              {(target) => (
                <Button
                  type="button"
                  variant="outline"
                  class="justify-start"
                  disabled={ctx.isMoving()}
                  onClick={() => {
                    setMoveOpen(false);
                    ctx.moveToOrganization(target.id);
                  }}
                >
                  {target.name} (@{target.username})
                </Button>
              )}
            </For>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose>{t`Cancel`}</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

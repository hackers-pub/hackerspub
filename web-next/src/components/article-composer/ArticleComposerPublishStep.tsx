import { createSignal, onMount, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import IconLoader2 from "~icons/lucide/loader-2";
import {
  ActingAccountSelect,
  useComposeActingAccountOptions,
} from "~/components/ActingAccountSelect.tsx";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { QuotePolicySelect } from "~/components/QuotePolicySelect.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Label } from "~/components/ui/label.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";
import { ComposerActionBar } from "./shared/ComposerActionBar.tsx";

export function ArticleComposerPublishStep() {
  const { t } = useLingui();
  const ctx = useArticleComposer();
  const params = useParams();
  const composeActingAccountOptions = useComposeActingAccountOptions();

  // Initialise origin after mount so SSR and the first client render agree
  // (both produce "/@handle/year/"), then update to the full URL client-side.
  const [origin, setOrigin] = createSignal("");
  onMount(() => setOrigin(window.location.origin));

  const urlPrefix = () =>
    `${origin()}/${params.handle}/${new Date().getFullYear()}/`;

  return (
    <>
      <div class="shrink-0 border-b px-4 py-4 sm:px-6">
        <h1 class="text-lg font-semibold leading-none tracking-tight">
          {t`Publish settings`}
        </h1>
        <p class="mt-1.5 text-sm text-muted-foreground">
          {t`Choose how this article appears and who can interact with it.`}
        </p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6">
          {/* Tags */}
          <div class="flex flex-col gap-1.5">
            <Label>{t`Tags`}</Label>
            <TagInput
              value={ctx.tags()}
              onChange={ctx.setTags}
              placeholder={t`Type tags separated by spaces`}
            />
            <p class="text-sm text-muted-foreground leading-6">
              {t`Separate tags with spaces. Tags help readers discover your article.`}
            </p>
          </div>

          {/* Slug — full width with URL prefix */}
          <TextField>
            <TextFieldLabel>{t`Slug (URL)`}</TextFieldLabel>
            <div class="flex h-10 w-full items-center rounded-md border border-input text-sm ring-offset-background focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
              <span class="pointer-events-none min-w-0 shrink select-none truncate pl-3 text-muted-foreground">
                {urlPrefix()}
              </span>
              <TextFieldInput
                value={ctx.slug()}
                onInput={(e) => ctx.setSlug(e.currentTarget.value)}
                placeholder={t`article-url-slug`}
                class="h-full min-w-[80px] flex-1 rounded-none border-0 bg-transparent py-0 pl-0 pr-3 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
            <TextFieldDescription>
              {t`This will be part of the article URL.`}
            </TextFieldDescription>
          </TextField>

          <Show when={composeActingAccountOptions().length > 1}>
            <div class="flex flex-col gap-1.5">
              <Label>{t`Author`}</Label>
              <ActingAccountSelect
                class="w-full"
                value={ctx.publishActingAccountKey()}
                onChange={ctx.setPublishActingAccountKey}
              />
            </div>
          </Show>

          {/* Language + Quote permission — 2 columns */}
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <Label>{t`Language`}</Label>
              <LanguageSelect
                class="w-full"
                value={ctx.language()}
                onChange={ctx.setLanguage}
              />
              <p class="text-sm text-muted-foreground leading-6">
                {t`The primary language of your article, used for accessibility and discovery.`}
              </p>
            </div>

            <div class="flex flex-col gap-1.5">
              <Label>{t`Quote permission`}</Label>
              <QuotePolicySelect
                class="w-full"
                value={ctx.quotePolicy()}
                onChange={ctx.setQuotePolicy}
              />
              <p class="text-sm text-muted-foreground leading-6">
                {t`Controls who can quote this article on their timeline.`}
              </p>
            </div>
          </div>

          {/* Allow LLM translation */}
          <div class="flex items-start gap-2">
            <input
              id="allow-llm-translation"
              type="checkbox"
              checked={ctx.allowLlmTranslation()}
              onChange={(e) =>
                ctx.setAllowLlmTranslation(e.currentTarget.checked)}
              aria-describedby="allow-llm-translation-description"
              class="mt-0.5 cursor-pointer rounded border-input"
            />
            <div class="grid gap-1.5 leading-none">
              <label
                for="allow-llm-translation"
                class="cursor-pointer text-sm font-medium leading-none"
              >
                {t`Allow automatic translation by AI`}
              </label>
              <p
                id="allow-llm-translation-description"
                class="text-sm text-muted-foreground leading-6"
              >
                {t`When enabled, AI may automatically translate this article into other languages.`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <ComposerActionBar
        start={
          <Show when={ctx.draft()?.id}>
            <Button
              type="button"
              variant="ghost"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={ctx.handleDelete}
              disabled={ctx.isDeleting()}
            >
              {ctx.isDeleting() ? t`Deleting…` : t`Delete draft`}
            </Button>
          </Show>
        }
        end={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => ctx.setIsPublishing(false)}
            >
              {t`Back to editing`}
            </Button>
            <Button
              type="button"
              onClick={() => ctx.handlePublish()}
              disabled={ctx.isSaving() || ctx.isPublishingMutation()}
            >
              <Show when={ctx.isSaving() || ctx.isPublishingMutation()}>
                <IconLoader2 class="size-4 animate-spin" aria-hidden="true" />
              </Show>
              {ctx.isPublishingMutation() ? t`Publishing…` : t`Publish now`}
            </Button>
          </>
        }
      />

      <AlertDialog
        open={ctx.showShortArticleSuggestion()}
        onOpenChange={(open) => ctx.setShowShortArticleSuggestion(open)}
      >
        <AlertDialogContent class="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Publish this as a note?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`This article is short enough to work well as a note. Notes appear directly in the timeline and do not need a title or URL slug.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose onClick={ctx.publishArticleAnyway}>
              {t`Publish article`}
            </AlertDialogClose>
            <AlertDialogAction onClick={() => ctx.saveAsNoteDraft()}>
              {t`Save as note draft`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={ctx.showReplaceNoteDraftConfirm()}
        onOpenChange={(open) => ctx.setShowReplaceNoteDraftConfirm(open)}
      >
        <AlertDialogContent class="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Replace local note draft?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`This browser already has a local note draft. Replacing it will overwrite that saved note draft.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>{t`Keep existing draft`}</AlertDialogClose>
            <AlertDialogAction onClick={() => ctx.saveAsNoteDraft(true)}>
              {t`Replace draft`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

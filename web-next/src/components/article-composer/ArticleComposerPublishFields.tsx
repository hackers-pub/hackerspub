import { Show } from "solid-js";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";

export function ArticleComposerPublishFields() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <>
      {/* Slug (for publishing) */}
      <Show when={ctx.isPublishing()}>
        <TextField>
          <TextFieldLabel>{t`Slug (URL)`}</TextFieldLabel>
          <TextFieldInput
            value={ctx.slug()}
            onInput={(e) => ctx.setSlug(e.currentTarget.value)}
            placeholder={t`article-url-slug`}
            required
          />
          <p class="text-xs text-muted-foreground mt-1">
            {t`This will be part of the article URL`}
          </p>
        </TextField>
      </Show>

      {/* Language (for publishing) */}
      <Show when={ctx.isPublishing()}>
        <div>
          <label class="text-sm font-medium">{t`Language`}</label>
          <LanguageSelect
            value={ctx.language()}
            onChange={ctx.setLanguage}
          />
        </div>
      </Show>
    </>
  );
}

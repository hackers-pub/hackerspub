import { Show } from "solid-js";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { QuotePolicySelect } from "~/components/QuotePolicySelect.tsx";
import { Label } from "~/components/ui/label.tsx";
import { Separator } from "~/components/ui/separator.tsx";
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";

export function ArticleComposerPublishFields() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <Show when={ctx.isPublishing()}>
      <Separator />
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Slug */}
        <TextField>
          <TextFieldLabel>{t`Slug (URL)`}</TextFieldLabel>
          <TextFieldInput
            value={ctx.slug()}
            onInput={(e) => ctx.setSlug(e.currentTarget.value)}
            placeholder={t`article-url-slug`}
            required
          />
          <TextFieldDescription>
            {t`This will be part of the article URL`}
          </TextFieldDescription>
        </TextField>

        {/* Language */}
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

        {/* Quote permission */}
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
    </Show>
  );
}

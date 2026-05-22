import { createSignal, onMount } from "solid-js";
import { useParams } from "@solidjs/router";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { QuotePolicySelect } from "~/components/QuotePolicySelect.tsx";
import { Label } from "~/components/ui/label.tsx";
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
  const params = useParams();

  // Initialise origin after mount so SSR and the first client render agree
  // (both produce "/@handle/year/"), then update to the full URL client-side.
  const [origin, setOrigin] = createSignal("");
  onMount(() => setOrigin(window.location.origin));

  const urlPrefix = () =>
    `${origin()}/${params.handle}/${new Date().getFullYear()}/`;

  return (
    <>
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

      {/* Language + Quote permission — 2 columns */}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

      {/* Allow LLM translation */}
      <div class="flex items-start gap-2">
        <input
          id="allow-llm-translation"
          type="checkbox"
          checked={ctx.allowLlmTranslation()}
          onChange={(e) => ctx.setAllowLlmTranslation(e.currentTarget.checked)}
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
    </>
  );
}

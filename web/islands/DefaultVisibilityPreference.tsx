import getFixedT from "../i18n.ts";
import type { PostVisibility } from "@hackerspub/models/schema";
import { Label } from "../components/Label.tsx";
import type { Language } from "../i18n.ts";

export interface DefaultVisibilityPreferenceProps {
  noteVisibility: PostVisibility;
  shareVisibility: PostVisibility;
  language: Language;
}

export function DefaultVisibilityPreference({
  noteVisibility,
  shareVisibility,
  language,
}: DefaultVisibilityPreferenceProps) {
  const t = getFixedT(language);

  return (
    <>
      <div class="mt-4 grid md:grid-cols-2 gap-5">
        <div>
          <Label label={t("settings.preferences.noteVisibility")}>
            <select
              name="noteVisibility"
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
              aria-label={t("composer.visibility")}
              value={noteVisibility}
            >
              <option value="public">
                {t("postVisibility.public")}
              </option>
              <option value="unlisted">
                {t("postVisibility.unlisted")}
              </option>
              <option value="followers">
                {t("postVisibility.followers")}
              </option>
              <option value="direct">
                {t("postVisibility.direct")}
              </option>
            </select>
          </Label>
          <p class="opacity-50">
            {t("settings.preferences.postVisibilityDescription")}
          </p>
        </div>
        <div>
          <Label label={t("settings.preferences.shareVisibility")}>
            <select
              name="shareVisibility"
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
              aria-label={t("composer.visibility")}
              value={shareVisibility}
            >
              <option value="public">
                {t("postVisibility.public")}
              </option>
              <option value="unlisted">
                {t("postVisibility.unlisted")}
              </option>
              <option value="followers">
                {t("postVisibility.followers")}
              </option>
              <option value="direct">
                {t("postVisibility.direct")}
              </option>
            </select>
          </Label>
          <p class="opacity-50">
            {t("settings.preferences.shareVisibilityDescription")}
          </p>
        </div>
      </div>
    </>
  );
}

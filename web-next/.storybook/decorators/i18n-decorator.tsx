import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type Messages, setupI18n } from "@lingui/core";
import { I18nProvider as LinguiI18nProvider } from "@lingui/solid";
import { createMemo, type JSX } from "solid-js";
import { messages as enUS } from "../../src/locales/en-US/messages.po";
import { messages as jaJP } from "../../src/locales/ja-JP/messages.po";
import { messages as koKR } from "../../src/locales/ko-KR/messages.po";
import { messages as zhCN } from "../../src/locales/zh-CN/messages.po";
import { messages as zhTW } from "../../src/locales/zh-TW/messages.po";

// Catalogs are imported statically so the decorator can provide i18n
// SYNCHRONOUSLY.  This matters when the decorator wraps stories via
// Storybook's decorator chain: the Solid renderer marks a story as
// rendered in `onMount` and returns `null` for story functions evaluated
// after that, so a decorator that gates `props.children` behind an async
// resource would render every story as an empty canvas.
const CATALOGS: Record<string, Messages> = {
  "en-US": enUS,
  "ja-JP": jaJP,
  "ko-KR": koKR,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export function I18nDecorator(props: {
  locale: string;
  children: JSX.Element;
}) {
  const i18n = createMemo(() =>
    setupI18n({
      locale: props.locale,
      locales: [props.locale],
      messages: { [props.locale]: CATALOGS[props.locale] ?? {} },
    }),
  );

  return (
    <LinguiI18nProvider i18n={i18n()}>
      <KobalteI18nProvider locale={props.locale}>
        {props.children}
      </KobalteI18nProvider>
    </LinguiI18nProvider>
  );
}

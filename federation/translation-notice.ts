import type { PublishedTranslationMetadata } from "@hackerspub/models/article-translation-metadata";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { escape } from "es-toolkit";

/**
 * Reader-facing wording for the translation credit and freshness notice that
 * Hackers' Pub prepends to each translated language's HTML in outgoing
 * ActivityPub objects.
 *
 * Peers that ignore FEP-22cd metadata still show readers who translated a
 * version and whether it may be behind the original. The wording is copied
 * from the web-next catalogs (`ArticleTranslationCredit.tsx` and
 * `ArticleSourceChangedNotice.tsx`) so a reader sees the same sentences on
 * Hackers' Pub and on a remote server; keep the two in sync.
 */
const MESSAGES = {
  en: {
    automatic: "Automatic translation",
    author: "Translated by the author",
    authorReviewed: "AI-assisted translation, reviewed by the author",
    account: "Translated by {0}",
    accountReviewed: "AI-assisted translation, reviewed by {0}",
    unavailable: "Translated by an unavailable account",
    unavailableReviewed:
      "AI-assisted translation, reviewed by an unavailable account",
    unknown: "Translation credit unavailable",
    changedTitle: "The original has changed",
    changedBody:
      "This translation may not include the latest changes to the original.",
    unverifiedTitle: "Translation freshness has not been verified.",
    unverifiedBody:
      "We cannot tell whether this translation reflects the latest version of the original.",
    readOriginal: "Read the original",
  },
  ja: {
    automatic: "自動翻訳",
    author: "投稿者による翻訳",
    authorReviewed: "AI補助翻訳、投稿者が確認",
    account: "{0}による翻訳",
    accountReviewed: "AI補助翻訳、{0}が確認",
    unavailable: "翻訳者のアカウントは利用不可",
    unavailableReviewed: "AI補助翻訳、確認者のアカウントは利用不可",
    unknown: "翻訳者の情報がありません",
    changedTitle: "原文が変更されました",
    changedBody:
      "この翻訳には原文の最新の変更が反映されていない可能性があります。",
    unverifiedTitle: "翻訳が最新かどうかは確認されていません。",
    unverifiedBody:
      "この翻訳が原文の最新版を反映しているかどうかは分かりません。",
    readOriginal: "原文を読む",
  },
  ko: {
    automatic: "자동 번역",
    author: "작성자가 직접 번역",
    authorReviewed: "AI 보조 번역, 작성자 검토",
    account: "{0} 번역",
    accountReviewed: "AI 보조 번역, {0} 검토",
    unavailable: "번역자 계정을 사용할 수 없음",
    unavailableReviewed: "AI 보조 번역, 검토자 계정을 사용할 수 없음",
    unknown: "번역자 정보 없음",
    changedTitle: "원문이 변경되었습니다",
    changedBody:
      "이 번역에는 원문의 최신 변경 사항이 반영되지 않았을 수 있습니다.",
    unverifiedTitle: "번역의 최신 여부를 확인할 수 없습니다.",
    unverifiedBody: "이 번역이 원문의 최신 내용을 반영하는지 알 수 없습니다.",
    readOriginal: "원문 읽기",
  },
  "zh-CN": {
    automatic: "自动翻译",
    author: "由作者翻译",
    authorReviewed: "AI 辅助翻译，由作者审核",
    account: "由{0}翻译",
    accountReviewed: "AI 辅助翻译，由{0}审核",
    unavailable: "译者账户不可用",
    unavailableReviewed: "AI 辅助翻译，审核者账户不可用",
    unknown: "无译者信息",
    changedTitle: "原文已变更",
    changedBody: "此翻译可能未包含原文的最新变更。",
    unverifiedTitle: "翻译的时效性未经验证。",
    unverifiedBody: "我们无法确定此翻译是否反映了原文的最新版本。",
    readOriginal: "阅读原文",
  },
  "zh-TW": {
    automatic: "自動翻譯",
    author: "由作者翻譯",
    authorReviewed: "AI 輔助翻譯，由作者審核",
    account: "由{0}翻譯",
    accountReviewed: "AI 輔助翻譯，由{0}審核",
    unavailable: "譯者帳戶無法使用",
    unavailableReviewed: "AI 輔助翻譯，審核者帳戶無法使用",
    unknown: "無譯者資訊",
    changedTitle: "原文已變更",
    changedBody: "此翻譯可能未包含原文的最新變更。",
    unverifiedTitle: "翻譯的時效性未經驗證。",
    unverifiedBody: "我們無法確定此翻譯是否反映原文的最新版本。",
    readOriginal: "閱讀原文",
  },
} as const;

type MessageLocale = keyof typeof MESSAGES;
type Messages = (typeof MESSAGES)[MessageLocale];

/** Picks the message table for a content language, falling back to English. */
export function getTranslationNoticeMessages(language: string): Messages {
  try {
    const matched = negotiateLocale(language, Object.keys(MESSAGES))
      ?.baseName as MessageLocale | undefined;
    return MESSAGES[matched ?? "en"];
  } catch {
    return MESSAGES.en;
  }
}

/** The live account credited as a translator, as the credit links to it. */
export interface TranslationNoticeAccount {
  /** Fediverse handle, e.g. `@alice@hackers.pub`. */
  readonly handle: string;
  /** Profile URL the handle links to. */
  readonly url: URL;
}

/**
 * Renders the credit line for one translated version as HTML in the
 * translation's own language.
 *
 * `provenance` decides the wording rather than the presence of an account, so
 * a deleted translator reads as "an unavailable account" instead of turning
 * human work into an automatic translation, mirroring `translationCredit()` in
 * web-next.
 */
export function renderTranslationCreditHtml(
  metadata: Pick<
    PublishedTranslationMetadata,
    "language" | "kind" | "translatorIsAuthor"
  >,
  translator: TranslationNoticeAccount | null,
): string {
  const messages = getTranslationNoticeMessages(metadata.language);
  if (metadata.kind === "machine") return escape(messages.automatic);
  const reviewed = metadata.kind === "machine_reviewed";
  if (translator == null) {
    if (metadata.kind === "unknown") return escape(messages.unknown);
    return escape(
      reviewed ? messages.unavailableReviewed : messages.unavailable,
    );
  }
  if (metadata.translatorIsAuthor) {
    return escape(reviewed ? messages.authorReviewed : messages.author);
  }
  const template = reviewed ? messages.accountReviewed : messages.account;
  const [before, after] = template.split("{0}");
  const link =
    `<a href="${escape(translator.url.href)}" class="mention u-url">` +
    `${escape(translator.handle)}</a>`;
  return `${escape(before)}${link}${escape(after ?? "")}`;
}

export interface TranslationHeaderInput {
  readonly metadata: Pick<
    PublishedTranslationMetadata,
    "language" | "kind" | "translatorIsAuthor" | "freshness"
  >;
  readonly translator: TranslationNoticeAccount | null;
  /**
   * The original-language version's permalink, with the language in the path
   * so it can never negotiate back to a translation.
   */
  readonly originalUrl: URL;
  readonly originalLanguage: string;
}

/**
 * Renders the block Hackers' Pub prepends to a translated version's HTML in
 * outgoing objects: the credit, a link to the original, and a freshness
 * notice when the version may be behind the original.
 *
 * It is generated at serialization time and never stored in the Markdown
 * source, so it always reflects the article's current state.
 */
export function renderTranslationHeaderHtml(
  input: TranslationHeaderInput,
): string {
  const messages = getTranslationNoticeMessages(input.metadata.language);
  const originalLink =
    `<a href="${escape(input.originalUrl.href)}" ` +
    `hreflang="${escape(input.originalLanguage)}">` +
    `${escape(messages.readOriginal)}</a>`;
  let html =
    `<p>${renderTranslationCreditHtml(input.metadata, input.translator)}` +
    ` · ${originalLink}</p>\n`;
  if (input.metadata.freshness === "source_changed") {
    html +=
      `<blockquote><p><strong>${escape(messages.changedTitle)}</strong>` +
      `<br>${escape(messages.changedBody)}</p></blockquote>\n`;
  } else if (input.metadata.freshness === "unknown") {
    html +=
      `<blockquote><p><strong>${escape(messages.unverifiedTitle)}</strong>` +
      `<br>${escape(messages.unverifiedBody)}</p></blockquote>\n`;
  }
  return `${html}<hr>\n`;
}

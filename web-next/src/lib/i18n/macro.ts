import type { I18n as LinguiI18n, MessageDescriptor } from "@lingui/core";
import type {
  ChoiceOptions,
  LabeledExpression,
  MacroMessageDescriptor,
  MessagePlaceholder,
} from "@lingui/core/macro";

export type I18n = {
  i18n: LinguiI18n;
  t: typeof _t;
};

declare function _t(descriptor: MacroMessageDescriptor): string;
declare function _t(
  literals: TemplateStringsArray,
  ...placeholders: unknown[]
): string;

export declare function plural(
  value: number | string | LabeledExpression<number | string>,
  options: ChoiceOptions,
): string;

declare function defineMessage(
  descriptor: MacroMessageDescriptor,
): MessageDescriptor;
declare function defineMessage(
  literals: TemplateStringsArray,
  ...placeholders: MessagePlaceholder[]
): MessageDescriptor;

export declare const msg: typeof defineMessage;

export declare function useLingui(): I18n;

import { ComponentChild, type ComponentChildren, createContext } from "preact";
import getFixedT, { DEFAULT_LANGUAGE, type Language } from "../i18n.ts";

const TranslationContext = createContext<
  [Language, ReturnType<typeof getFixedT>]
>([DEFAULT_LANGUAGE, getFixedT()]);

export interface TranslationSetupProps {
  language?: Language | null;
  children: ComponentChildren;
}

export function TranslationSetup(props: TranslationSetupProps) {
  const t = getFixedT(props.language);
  return (
    <TranslationContext.Provider
      value={[props.language ?? DEFAULT_LANGUAGE, t]}
    >
      {props.children}
    </TranslationContext.Provider>
  );
}

export interface TranslationProps {
  children(
    t: ReturnType<typeof getFixedT>,
    language: Language,
  ): ComponentChildren;
}

export function Translation(props: TranslationProps) {
  return (
    <TranslationContext.Consumer>
      {([lang, t]) => props.children(t, lang)}
    </TranslationContext.Consumer>
  );
}

export type MsgKey = Exclude<
  Exclude<
    Parameters<ReturnType<typeof getFixedT>>[0],
    string | string[] | TemplateStringsArray
  >[number],
  TemplateStringsArray
>;

export type MsgOptions = Exclude<
  Parameters<ReturnType<typeof getFixedT>>[1],
  string | undefined
>;

export type MsgProps = {
  $key: MsgKey;
} & MsgOptions;

export function Msg(props: MsgProps) {
  const placeholders: Record<string, string | number> = {};
  for (const key in props) {
    if (key === "$key") continue;
    if (key === "count") {
      placeholders.count = Number(props.count);
      continue;
    }
    placeholders[key] = `~~[[${key}]]~~`;
  }
  return (
    <TranslationContext.Consumer>
      {([_, t]) => {
        const translated = t(props.$key, placeholders as unknown as string);
        const interpolated: ComponentChild[] = [];
        let lastIndex = 0;
        const re = /~~\[\[(\w+)]]~~/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(translated)) !== null) {
          interpolated.push(translated.substring(lastIndex, match.index));
          interpolated.push(props[match[1]] as ComponentChild);
          lastIndex = match.index + match[0].length;
        }
        interpolated.push(translated.substring(lastIndex));
        return interpolated;
      }}
    </TranslationContext.Consumer>
  );
}

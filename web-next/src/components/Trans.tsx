import escape from "regexp.escape";
import { createMemo, JSX } from "solid-js";

export interface TransProps {
  readonly message: string;
  readonly values: Record<string, () => JSX.Element | string>;
}

/**
 * A utility component to translate messages with placeholders.
 *
 * @example
 * ```tsx
 * <Trans
 *   message={t`Hello, ${"NAME"}! Welcome to ${"PAGE"}!`},
 *   values={{
 *     NAME: () => <strong>John</strong>,
 *     PAGE: () => <a href="/home">Home</a>,
 *   }}
 * />
 * ```
 */
export function Trans(props: TransProps) {
  const placeholders = createMemo(() => Object.keys(props.values));
  const pattern = createMemo(() =>
    new RegExp(placeholders().map(RegExp.escape ?? escape).join("|"), "g")
  );
  const elements = createMemo(() => {
    const patternObject = pattern();
    const elements: (JSX.Element | string)[] = [];
    let i = 0;
    while (true) {
      const match = patternObject.exec(props.message);
      const pos = match ? match.index : props.message.length;
      elements.push(props.message.substring(i, pos));
      if (!match) break;
      elements.push(props.values[match[0]]());
      i = pos + match[0].length;
    }
    return elements;
  });
  return <>{elements()}</>;
}

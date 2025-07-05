import { JSX } from "solid-js";

export interface TransProps {
  readonly message: string;
  readonly values: Record<string, JSX.Element | string>;
}

/**
 * A utility component to translate messages with placeholders.
 *
 * @example
 * ```tsx
 * <Trans
 *   message={t`Hello, ${"NAME"}! Welcome to ${"PAGE"}!`},
 *   values={{
 *     NAME: <strong>John</strong>,
 *     PAGE: <a href="/home">Home</a>,
 *   }}
 * />
 * ```
 */
export function Trans({ message, values }: TransProps) {
  const placeholders = Object.keys(values);
  const pattern = new RegExp(placeholders.map(RegExp.escape).join("|"), "g");
  const elements: (JSX.Element | string)[] = [];
  let i = 0;
  do {
    const match = pattern.exec(message);
    const pos = match ? match.index : message.length;
    elements.push(message.substring(i, pos));
    if (!match) break;
    elements.push(values[match[0]]);
    i = pos + match[0].length;
  } while (true);
  return elements;
}

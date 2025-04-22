import type { JSX } from "preact";

export type TextAreaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea(props: TextAreaProps) {
  const propsWithoutClass = { ...props };
  delete propsWithoutClass.class;
  return (
    <textarea
      {...propsWithoutClass}
      class={`border dark:border-stone-500 dark:bg-stone-900 px-2 py-1 ${
        props.class ?? ""
      }`}
    />
  );
}

import type { JSX } from "preact";

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

export function Input(props: InputProps) {
  const propsWithoutClass = { ...props };
  delete propsWithoutClass.class;
  return (
    <input
      {...propsWithoutClass}
      class={`border dark:border-stone-500 dark:bg-stone-900 px-2 py-1 ${props.class}`}
    />
  );
}

import { JSX } from "preact";

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button(props: ButtonProps) {
  const propsWithoutClass = { ...props };
  delete propsWithoutClass.class;
  delete propsWithoutClass.children;
  return (
    <button
      {...propsWithoutClass}
      class={`
        border-2
        bg-gray-200 border-gray-300 border-t-gray-100 border-l-gray-100 
        dark:bg-stone-600 dark:border-stone-700 dark:border-t-stone-500 dark:border-l-stone-500
        active:bg-gray-300 active:border-gray-400 active:border-b-gray-200 active:border-r-gray-200
        dark:active:bg-stone-700 dark:active:border-stone-800 dark:border-b-stone-600 dark:border-r-stone-600
        disabled:text-stone-500 dark:disabled:text-stone-400 disabled:cursor-not-allowed
        active:disabled:bg-gray-200 active:disabled:border-gray-300 active:disabled:border-t-gray-100 active:disabled:border-l-gray-100
        dark:active:disabled:bg-stone-600 dark:active:disabled:border-stone-700 dark:active:disabled:border-t-stone-500 dark:active:disabled:border-l-stone-500
        focus:outline-dotted focus:outline-1 focus:outline-gray-600
        px-2 py-1
        ${props.class}
      `}
    >
      {props.children}
    </button>
  );
}

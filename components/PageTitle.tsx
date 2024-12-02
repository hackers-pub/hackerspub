import type { ComponentChildren } from "preact";

export interface PageTitleProps {
  class?: string;
  children?: ComponentChildren;
  subtitle?: {
    text: ComponentChildren;
    class?: string;
  };
}

export function PageTitle(props: PageTitleProps) {
  return (
    <div class={props.class}>
      <h1
        class={`text-xl font-bold ${props.subtitle == null ? "mb-5" : "mb-1"}`}
      >
        {props.children}
      </h1>
      {props.subtitle && (
        <p
          class={`font-normal text-gray-600 dark:text-stone-400 mb-5 ${props.subtitle.class}`}
        >
          {props.subtitle.text}
        </p>
      )}
    </div>
  );
}

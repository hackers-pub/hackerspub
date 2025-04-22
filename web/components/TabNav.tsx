import type { ComponentChildren } from "preact";

export interface TabProps {
  selected: boolean;
  href: string;
  children: ComponentChildren;
}

export function Tab({ selected, href, children }: TabProps) {
  return selected
    ? (
      <a
        href={href}
        class="block p-4 bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100 font-bold whitespace-nowrap"
      >
        {children}
      </a>
    )
    : (
      <a
        href={href}
        class="block p-4 text-stone-500 hover:bg-stone-200 dark:text-stone-500 dark:hover:bg-stone-800 whitespace-nowrap"
      >
        {children}
      </a>
    );
}

export interface TabNavProps {
  children: ComponentChildren;
  class?: string;
}

export function TabNav(props: TabNavProps) {
  return (
    <nav
      class={`
        border-b border-stone-300 dark:border-stone-700 flex max-w-full overflow-x-auto
        ${props.class ?? "mt-6"}
      `}
    >
      {props.children}
    </nav>
  );
}

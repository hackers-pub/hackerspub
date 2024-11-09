import { type ComponentChildren } from "preact";

export interface LabelProps {
  label: string;
  required?: boolean;
  children: ComponentChildren;
  class?: string;
}

export function Label({ class: klass, label, required, children }: LabelProps) {
  return (
    <label class={klass}>
      <span class="block">
        <strong>{label}</strong>{" "}
        {required
          ? <span class="text-red-700 dark:text-red-500">*</span>
          : null}
      </span>
      {children}
    </label>
  );
}

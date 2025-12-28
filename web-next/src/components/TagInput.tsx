import { createSignal, For } from "solid-js";
import { Badge } from "~/components/ui/badge.tsx";
import { cn } from "~/lib/utils.ts";

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  class?: string;
}

export function TagInput(props: TagInputProps) {
  const [inputValue, setInputValue] = createSignal("");

  const addTag = (tag: string) => {
    const normalized = tag.trim().replace(/^#\s*/, "");
    if (normalized && !props.value.includes(normalized)) {
      props.onChange([...props.value, normalized]);
    }
    setInputValue("");
  };

  const removeTag = (index: number) => {
    props.onChange(props.value.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      addTag(inputValue());
    } else if (
      e.key === "Backspace" && !inputValue() && props.value.length > 0
    ) {
      removeTag(props.value.length - 1);
    }
  };

  const handleBlur = () => {
    if (inputValue().trim()) {
      addTag(inputValue());
    }
  };

  return (
    <div
      class={cn(
        "flex flex-wrap gap-2 p-2 border rounded-md min-h-[42px] focus-within:ring-2 focus-within:ring-ring",
        props.class,
      )}
    >
      <For each={props.value}>
        {(tag, index) => (
          <Badge variant="secondary" class="flex items-center gap-1">
            {tag}
            <button
              type="button"
              onClick={() =>
                removeTag(index())}
              class="ml-1 hover:text-destructive"
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          </Badge>
        )}
      </For>
      <input
        type="text"
        value={inputValue()}
        onInput={(e) => setInputValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={props.value.length === 0 ? props.placeholder : ""}
        class="flex-1 min-w-[120px] outline-none bg-transparent"
      />
    </div>
  );
}

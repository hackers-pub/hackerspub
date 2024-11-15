import { useState } from "preact/hooks";

export interface TagInputProps {
  class?: string;
  onTagsChange?: (tags: string[]) => void;
}

export function TagInput({ class: className, onTagsChange }: TagInputProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState<string>("");

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.key === " " || e.key === "," || e.key === "Enter") && input.trim()) {
      e.preventDefault();
      const newTags = [...tags, input.trim().replace(/^#+\s*/, "")];
      setTags(newTags);
      setInput("");
      onTagsChange?.(newTags);
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      const newTags = tags.slice(0, -1);
      setTags(newTags);
      onTagsChange?.(newTags);
    }
  };

  const removeTag = (indexToRemove: number) => {
    const newTags = tags.filter((_, index) => index !== indexToRemove);
    setTags(newTags);
    onTagsChange?.(newTags);
  };

  return (
    <div class={className}>
      <div class="min-h-[3.75rem] h-full p-2 flex flex-wrap gap-2 border-4 border-transparent focus-within:border-stone-200 dark:focus-within:border-stone-700">
        {tags.map((tag, index) => (
          <span
            key={index}
            class="inline-flex items-center gap-1 bg-stone-800 text-stone-200 dark:bg-stone-200 dark:text-stone-800 px-2 py-1 rounded-full text-sm"
          >
            {tag}
            <button
              onClick={() => removeTag(index)}
              class="hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-200 rounded-full p-2"
              aria-label="Remove tag"
            >
              <svg
                class="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
              >
                <path
                  d="M6 18L18 6M6 6l12 12"
                  strokeWidth="2"
                  strokeLinecap="round"
                  style="stroke-width: 4;"
                />
              </svg>
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onInput={(e: Event) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => handleKeyDown(e)}
          class="flex-1 outline-none min-w-[120px] h-full bg-transparent"
          placeholder={tags.length === 0 ? "Type tags separated by spaces" : ""}
        />
      </div>
    </div>
  );
}

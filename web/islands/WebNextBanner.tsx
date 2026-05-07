import { useEffect, useState } from "preact/hooks";

export interface WebNextBannerProps {
  text: string;
  action: string;
}

export function WebNextBanner({ text, action }: WebNextBannerProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hasWebNext = document.cookie
      .split(";")
      .some((c) => c.trim().startsWith("web-next="));
    if (!hasWebNext) setVisible(true);
  }, []);

  if (!visible) return null;

  function handleClick() {
    document.cookie = "web-next=true; path=/; max-age=31536000; SameSite=Lax";
    location.reload();
  }

  return (
    <div class="w-full bg-stone-800 text-stone-100 dark:bg-stone-200 dark:text-stone-900 py-2 px-4 flex items-center justify-center gap-4 text-sm">
      <span>{text}</span>
      <button
        type="button"
        onClick={handleClick}
        class="underline font-semibold cursor-pointer"
      >
        {action}
      </button>
    </div>
  );
}

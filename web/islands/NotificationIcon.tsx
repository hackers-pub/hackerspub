import { useEffect, useState } from "preact/hooks";

export interface NotificationIconProps {
  class?: string;
  title?: string;
  unreadTitle?: string;
}

export function NotificationIcon(props: NotificationIconProps) {
  const [unread, setUnread] = useState(false);
  function poll() {
    fetch("/notifications", {
      headers: { Accept: "application/json" },
    })
      .then((response) => response.json())
      .then((unread) => setUnread(unread))
      .catch(() => {});
  }
  useEffect(() => {
    if (unread) return;
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [unread]);
  return (
    <a
      href="/notifications"
      class={`block ${props.class ?? ""}`}
      title={unread ? props.unreadTitle : props.title}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        class="size-[30px] stroke-[1.5]"
        aria-label={unread ? props.unreadTitle : props.title}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
        />
        {unread && (
          <circle
            class="fill-red-500 stroke-none"
            cx="20"
            cy="20"
            r="3.5"
          />
        )}
      </svg>
    </a>
  );
}

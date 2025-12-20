import type { ComponentChildren } from "preact";
import { Button } from "../components/Button.tsx";

interface CancelButtonProps {
  username: string;
  class?: string;
  children: ComponentChildren;
}

export default function CancelButton(
  { username, class: className, children }: CancelButtonProps,
) {
  const handleClick = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = `/@${username}`;
    }
  };

  return (
    <Button
      type="button"
      onClick={handleClick}
      class={className}
    >
      {children}
    </Button>
  );
}

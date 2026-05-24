import { parseQuery } from "@hackerspub/models/search";
import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, Show } from "solid-js";
import { SearchGuide } from "~/components/SearchGuide.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

interface SearchFormProps {
  value?: string;
}

export function SearchForm(props: SearchFormProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [isPending, setIsPending] = createSignal(false);
  let searchInput: HTMLInputElement | undefined;

  createEffect(() => {
    props.value;
    setIsPending(false);
  });

  return (
    <form
      method="get"
      action="/search"
      class="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        const query = formData.get("q")?.toString() ?? "";
        searchInput?.blur();
        if (query === (props.value ?? "")) return;
        const expr = parseQuery(query);
        if (expr?.type === "hashtag") {
          navigate(`/tags/${encodeURIComponent(expr.hashtag)}`);
          return;
        }
        if (query !== "") setIsPending(true);
        navigate(`/search?q=${encodeURIComponent(query)}`);
      }}
    >
      <div class="relative min-w-0 flex-1">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          aria-hidden="true"
          class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
        <input
          ref={searchInput}
          type="search"
          name="q"
          value={props.value ?? ""}
          placeholder={t`Search posts…`}
          aria-label={t`Search`}
          class="peer flex h-10 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
        <Show when={props.value}>
          <div class="absolute left-0 right-0 top-full z-10 mt-2 hidden peer-focus:block">
            <SearchGuide />
          </div>
        </Show>
      </div>
      <Button
        type="submit"
        disabled={isPending()}
        aria-busy={isPending()}
        class="shrink-0"
      >
        <Show when={isPending()} fallback={t`Search`}>
          <SearchSpinnerIcon />
          <span>{t`Searching…`}</span>
        </Show>
      </Button>
    </form>
  );
}

function SearchSpinnerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      aria-hidden="true"
      class="animate-spin"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
      />
    </svg>
  );
}

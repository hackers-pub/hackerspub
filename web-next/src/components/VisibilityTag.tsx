import { Match, Switch } from "solid-js";
import { Tooltip, TooltipContent } from "~/components/ui/tooltip.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostVisibility } from "./__generated__/NoteCard_note.graphql.ts";
import { TooltipTrigger } from "./ui/tooltip.tsx";

export interface VisibilityTagProps {
  visibility: PostVisibility;
}

export function VisibilityTag(props: VisibilityTagProps) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <Switch>
        <Match when={props.visibility === "PUBLIC"}>
          <TooltipTrigger class="flex flex-row items-center gap-0.5 cursor-help">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418"
              />
            </svg>
            {t`Public`}
          </TooltipTrigger>
          <TooltipContent>
            {t`Visible to everyone, including non-registered users. The post will appear in the public timeline as well.`}
          </TooltipContent>
        </Match>
        <Match when={props.visibility === "UNLISTED"}>
          <TooltipTrigger class="flex flex-row items-center gap-0.5 cursor-help">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
              />
            </svg>
            {t`Quiet public`}
          </TooltipTrigger>
          <TooltipContent>
            {t`Visible to everyone, but does not appear in the public timeline. Only those with the link can or who follow the author can see it.`}
          </TooltipContent>
        </Match>
        <Match when={props.visibility === "FOLLOWERS"}>
          <TooltipTrigger class="flex flex-row items-center gap-0.5 cursor-help">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
            {t`Followers only`}
          </TooltipTrigger>
          <TooltipContent>
            {t`Visible only to the author's followers. The post will not appear in the public timeline, and only those who follow the author can see it.`}
          </TooltipContent>
        </Match>
        <Match when={props.visibility === "DIRECT"}>
          <TooltipTrigger class="flex flex-row items-center gap-0.5 cursor-help">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25"
              />
            </svg>
            {t`Mentioned only`}
          </TooltipTrigger>
          <TooltipContent>
            {t`Visible only to the users mentioned in the post. The post will not appear in the public timeline, and only those mentioned can see it.`}
          </TooltipContent>
        </Match>
      </Switch>
    </Tooltip>
  );
}

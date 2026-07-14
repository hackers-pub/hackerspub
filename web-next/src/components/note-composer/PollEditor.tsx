import { For } from "solid-js";
import IconListChecks from "~icons/lucide/list-checks";
import IconPlus from "~icons/lucide/plus";
import IconTrash from "~icons/lucide/trash-2";
import IconX from "~icons/lucide/x";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { PollController } from "./createPollController.ts";
import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS } from "./pollState.ts";

export interface PollEditorProps {
  poll: PollController;
}

export function PollEditor(props: PollEditorProps) {
  const { t } = useLingui();

  return (
    <section class="rounded-md border border-input p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2">
          <IconListChecks class="size-4 shrink-0 text-muted-foreground" />
          <h3 class="text-sm font-medium">{t`Poll`}</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-7 shrink-0"
          title={t`Remove poll`}
          aria-label={t`Remove poll`}
          onClick={props.poll.reset}
        >
          <IconX class="size-4" />
        </Button>
      </div>

      <div class="mt-3 grid gap-3">
        <label class="grid gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">
            {t`Poll title`}
          </span>
          <input
            type="text"
            value={props.poll.title()}
            maxLength={200}
            onInput={(event) => props.poll.setTitle(event.currentTarget.value)}
            placeholder={t`What should people decide?`}
            class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        <div class="grid gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">
            {t`Selection`}
          </span>
          <div class="grid grid-cols-2 overflow-hidden rounded-md border border-input">
            <Button
              type="button"
              variant={props.poll.multiple() ? "ghost" : "secondary"}
              class="h-9 rounded-none border-r"
              onClick={() => props.poll.setMultiple(false)}
            >
              {t`Single choice`}
            </Button>
            <Button
              type="button"
              variant={props.poll.multiple() ? "secondary" : "ghost"}
              class="h-9 rounded-none"
              onClick={() => props.poll.setMultiple(true)}
            >
              {t`Multiple choice`}
            </Button>
          </div>
        </div>

        <div class="grid gap-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-muted-foreground">
              {t`Options`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.poll.options().length >= MAX_POLL_OPTIONS}
              onClick={props.poll.addOption}
            >
              <IconPlus class="mr-1 size-3.5" />
              {t`Add option`}
            </Button>
          </div>
          <For each={props.poll.options()}>
            {(option, index) => (
              <div class="grid grid-cols-[1fr_auto] gap-2">
                <input
                  type="text"
                  value={option.title}
                  maxLength={200}
                  onInput={(event) =>
                    props.poll.setOptionTitle(
                      option.localId,
                      event.currentTarget.value,
                    )}
                  placeholder={t`Option ${index() + 1}`}
                  class="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="size-9 text-muted-foreground hover:text-foreground"
                  disabled={props.poll.options().length <= MIN_POLL_OPTIONS}
                  title={t`Remove option`}
                  aria-label={t`Remove option`}
                  onClick={() => props.poll.removeOption(option.localId)}
                >
                  <IconTrash class="size-4" />
                </Button>
              </div>
            )}
          </For>
        </div>

        <div class="grid gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">
            {t`Deadline`}
          </span>
          <div class="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.poll.setDuration(1)}
            >
              {t`1 day`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.poll.setDuration(3)}
            >
              {t`3 days`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.poll.setDuration(7)}
            >
              {t`1 week`}
            </Button>
          </div>
          <input
            type="datetime-local"
            value={props.poll.ends()}
            onInput={(event) => props.poll.setEnds(event.currentTarget.value)}
            class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <p class="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          {t`Polls cannot be edited after publishing.`}
        </p>
      </div>
    </section>
  );
}

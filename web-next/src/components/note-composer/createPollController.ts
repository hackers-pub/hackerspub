import { type Accessor, createSignal } from "solid-js";
import type { NoteDraftPoll } from "~/lib/noteDraftStorage.ts";
import {
  addPollOption,
  createPollDraft,
  type PollDraft,
  type PollValidationResult,
  removePollOption,
  restorePollDraft,
  setPollDuration,
  validatePollDraft,
} from "./pollState.ts";

export interface PollController {
  readonly draft: Accessor<PollDraft>;
  readonly enabled: Accessor<boolean>;
  readonly title: Accessor<string>;
  readonly multiple: Accessor<boolean>;
  readonly ends: Accessor<string>;
  readonly options: Accessor<PollDraft["options"]>;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setTitle: (title: string) => void;
  readonly setMultiple: (multiple: boolean) => void;
  readonly setEnds: (ends: string) => void;
  readonly setDuration: (days: number) => void;
  readonly addOption: () => void;
  readonly removeOption: (localId: string) => void;
  readonly setOptionTitle: (localId: string, title: string) => void;
  readonly restore: (draft: NoteDraftPoll, allowed: boolean) => void;
  readonly reset: () => void;
  readonly snapshot: () => NoteDraftPoll;
  readonly validate: () => PollValidationResult;
}

export function createPollController(): PollController {
  const [draft, setDraft] = createSignal<PollDraft>(createPollDraft());

  const reset = () => setDraft(createPollDraft());

  return {
    draft,
    enabled: () => draft().enabled,
    title: () => draft().title,
    multiple: () => draft().multiple,
    ends: () => draft().ends,
    options: () => draft().options,
    setEnabled: (enabled) => setDraft((current) => ({ ...current, enabled })),
    setTitle: (title) => setDraft((current) => ({ ...current, title })),
    setMultiple: (multiple) =>
      setDraft((current) => ({ ...current, multiple })),
    setEnds: (ends) => setDraft((current) => ({ ...current, ends })),
    setDuration: (days) =>
      setDraft((current) => ({
        ...current,
        ends: setPollDuration(new Date(), days),
      })),
    addOption: () => setDraft((current) => addPollOption(current)),
    removeOption: (localId) =>
      setDraft((current) => removePollOption(current, localId)),
    setOptionTitle: (localId, title) =>
      setDraft((current) => ({
        ...current,
        options: current.options.map((option) =>
          option.localId === localId ? { ...option, title } : option
        ),
      })),
    restore: (stored, allowed) => setDraft(restorePollDraft(stored, allowed)),
    reset,
    snapshot: () => ({
      enabled: draft().enabled,
      title: draft().title,
      multiple: draft().multiple,
      ends: draft().ends,
      options: draft().options.map((option) => ({ ...option })),
    }),
    validate: () => validatePollDraft(draft()),
  };
}

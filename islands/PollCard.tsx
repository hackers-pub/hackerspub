import { useEffect, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import type {
  Account,
  Actor,
  Poll,
  PollOption,
  PollVote,
} from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";

export interface PollCardProps {
  language: Language;
  postId: Uuid;
  signedAccount?: Account & { actor: Actor };
  class?: string | null;
}

type EnrichedPoll = Poll & {
  options: PollOption[];
  votes: PollVote[];
};

export function PollCard(
  { language, postId, signedAccount, class: cls }: PollCardProps,
) {
  const [poll, setPoll] = useState<EnrichedPoll | null | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [checkedOptions, setCheckedOptions] = useState(new Set<number>());
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idPrefix] = useState<string>(crypto.randomUUID());
  const votesCount = poll?.options.reduce((v, o) => v + o.votesCount, 0) ?? 0;
  const formatter = new Intl.NumberFormat(language, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const votedOptions = poll == null ? new Set<number>() : new Set(
    poll.votes.filter((v) => v.actorId === signedAccount?.actor.id).map((v) =>
      v.optionIndex
    ),
  );
  const pollEnded = poll != null && new Date(poll.ends) < currentTime;
  const votable = signedAccount != null && poll != null &&
    !pollEnded &&
    !poll.votes.some((v) => v.actorId === signedAccount.actor.id) &&
    votedOptions.size < 1;
  const submittable = votable &&
    (poll.multiple ? checkedOptions.size > 0 : selectedOption != null);

  useEffect(() => {
    if (poll != null) return;
    fetch(`/api/posts/${postId}/poll`)
      .then((response) => response.json())
      .then((data: EnrichedPoll) => {
        setPoll(data);
      })
      .catch((_) => setPoll(null));
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  function vote(event: MouseEvent) {
    event.preventDefault();
    setSubmitting(true);
    fetch(`/api/posts/${postId}/vote`, {
      method: "POST",
      body: JSON.stringify(
        poll?.multiple ? [...checkedOptions] : [selectedOption],
      ),
      headers: {
        "Content-Type": "application/json",
      },
    })
      .then((response) => response.json())
      .then((data: EnrichedPoll) => {
        setPoll(data);
        setCheckedOptions(new Set());
        setSelectedOption(null);
        setSubmitting(false);
      });
  }

  return (
    <TranslationSetup language={language}>
      {poll !== null &&
        (
          <div class={`bg-stone-100 dark:bg-stone-800 p-4 w-fit ${cls ?? ""}`}>
            {typeof poll === "undefined"
              ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  fill="currentColor"
                  className="size-8 mx-auto my-8"
                >
                  <style>
                    {`.spinner_P7sC{transform-origin:center;animation:spinner_svv2 .75s infinite linear}@keyframes spinner_svv2{100%{transform:rotate(360deg)}}`}
                  </style>
                  <path
                    d="M10.14,1.16a11,11,0,0,0-9,8.92A1.59,1.59,0,0,0,2.46,12,1.52,1.52,0,0,0,4.11,10.7a8,8,0,0,1,6.66-6.61A1.42,1.42,0,0,0,12,2.69h0A1.57,1.57,0,0,0,10.14,1.16Z"
                    class="spinner_P7sC"
                  />
                </svg>
              )
              : (
                <table class="sm:w-[40ch] md:w-[50ch] lg:w-[65ch]">
                  <tbody>
                    {poll.options.map((option) => (
                      <tr key={option.index}>
                        <td class="pr-2">
                          {poll.multiple
                            ? (
                              <input
                                id={`${idPrefix}-${postId}-${option.index}`}
                                type="checkbox"
                                class={votable ? "cursor-pointer" : ""}
                                disabled={!votable}
                                checked={checkedOptions.has(option.index) ||
                                  votedOptions.has(option.index)}
                                onChange={() => {
                                  setCheckedOptions((prev) => {
                                    const newSet = new Set(prev);
                                    if (newSet.has(option.index)) {
                                      newSet.delete(option.index);
                                    } else {
                                      newSet.add(option.index);
                                    }
                                    return newSet;
                                  });
                                }}
                              />
                            )
                            : (
                              <input
                                id={`${idPrefix}-${postId}-${option.index}`}
                                type="radio"
                                class={votable ? "cursor-pointer" : ""}
                                disabled={!votable}
                                checked={selectedOption === option.index ||
                                  votedOptions.has(option.index)}
                                onChange={() => setSelectedOption(option.index)}
                              />
                            )}
                        </td>
                        <th class="w-full text-left">
                          <label
                            for={`${idPrefix}-${postId}-${option.index}`}
                            class={`
                              absolute z-10
                              ${votable ? "cursor-pointer" : ""}
                            `}
                          >
                            {option.title}
                          </label>
                          <div
                            class="relative bg-black dark:bg-white opacity-15 h-5 z-0"
                            style={{
                              width: `${
                                option.votesCount > 0
                                  ? (option.votesCount / votesCount) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </th>
                        <td class="text-right whitespace-nowrap">
                          {formatter.format(
                            votesCount > 0 ? option.votesCount / votesCount : 0,
                          )}
                        </td>
                        <td class="text-right whitespace-nowrap relative z-10 opacity-50">
                          ({option.votesCount.toLocaleString(language)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan={pollEnded ? 3 : 2} class="opacity-50">
                        <Msg
                          $key="poll.totalVoters"
                          voters={
                            <strong>
                              {poll.votersCount}
                            </strong>
                          }
                        />
                      </td>
                      {!pollEnded &&
                        (
                          <td colspan={2} class="text-right">
                            <Button
                              type="button"
                              disabled={!submittable}
                              onClick={vote}
                            >
                              <Msg
                                $key={votedOptions.size > 0
                                  ? "poll.voted"
                                  : submitting
                                  ? "poll.submittingVote"
                                  : "poll.submitVote"}
                              />
                            </Button>
                          </td>
                        )}
                    </tr>
                  </tfoot>
                </table>
              )}
          </div>
        )}
    </TranslationSetup>
  );
}

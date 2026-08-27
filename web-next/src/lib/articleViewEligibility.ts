export interface ArticleViewEligibilityGate {
  update(eligible: boolean): void;
  dispose(): void;
}

interface ArticleViewEligibilityGateOptions {
  readonly delayMilliseconds: number;
  readonly onEligible: () => void;
  readonly schedule?: (
    callback: () => void,
    delayMilliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createArticleViewEligibilityGate(
  options: ArticleViewEligibilityGateOptions,
): ArticleViewEligibilityGate {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;

  const clear = () => {
    if (timer == null) return;
    cancel(timer);
    timer = undefined;
  };

  return {
    update(eligible) {
      if (completed) return;
      if (!eligible) {
        clear();
        return;
      }
      if (timer != null) return;
      timer = schedule(() => {
        timer = undefined;
        completed = true;
        options.onEligible();
      }, options.delayMilliseconds);
    },
    dispose() {
      completed = true;
      clear();
    },
  };
}

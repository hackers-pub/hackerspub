export interface PublicTimelineRefetchInput {
  actingAccountId: string | null;
  language: string | undefined;
}

export function createPublicTimelineRefetchTracker(
  initialInput: PublicTimelineRefetchInput,
): (input: PublicTimelineRefetchInput) => boolean {
  let previousInput = initialInput;
  return (input) => {
    if (
      input.actingAccountId === previousInput.actingAccountId &&
      input.language === previousInput.language
    ) {
      return false;
    }
    previousInput = input;
    return true;
  };
}

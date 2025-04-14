export function toDate(instant: Temporal.Instant): Date | undefined;
export function toDate(instant: Temporal.Instant | null): Date | null;
export function toDate(instant?: Temporal.Instant): Date | undefined;
export function toDate(
  instant?: Temporal.Instant | null,
): Date | undefined | null {
  if (instant == null) return instant;
  if (
    Temporal.Instant.compare(
      instant,
      Temporal.Instant.fromEpochMilliseconds(0),
    ) < 0
  ) {
    return undefined;
  }
  return new Date(instant.toString());
}

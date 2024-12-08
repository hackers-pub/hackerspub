export function toDate(instant: Temporal.Instant): Date;
export function toDate(instant: Temporal.Instant | null): Date | null;
export function toDate(instant?: Temporal.Instant): Date | undefined;
export function toDate(
  instant?: Temporal.Instant | null,
): Date | undefined | null {
  if (instant == null) return instant;
  return new Date(instant.toString());
}

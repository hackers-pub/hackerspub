import { createSignal } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface TimestampProps {
  value: Date | string;
}

export function Timestamp(props: TimestampProps) {
  const { i18n } = useLingui();
  const date = new Date(props.value);
  const [targetDate, setTargetDate] = createSignal(new Date());
  setInterval(() => {
    setTargetDate(new Date());
  }, 1000);
  return (
    <time
      datetime={date.toISOString()}
      title={date.toLocaleString(i18n.locale, {
        dateStyle: "full",
        timeStyle: "full",
      })}
    >
      {formatRelativeTime(targetDate(), date, i18n.locale)}
    </time>
  );
}

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 31536000000 }, // 365 days
  { unit: "month", ms: 2628000000 }, // 30 days
  { unit: "week", ms: 604800000 }, // 7 days
  { unit: "day", ms: 86400000 }, // 24 hours
  { unit: "hour", ms: 3600000 }, // 60 minutes
  { unit: "minute", ms: 60000 }, // 60 seconds
  { unit: "second", ms: 1000 },
];

function formatRelativeTime(
  currentDate: Date,
  targetDate: Date,
  locale: string,
  options: Intl.RelativeTimeFormatOptions & { allowFuture?: boolean } = {
    numeric: "auto",
  },
): string {
  const diffMs = options.allowFuture
    ? targetDate.getTime() - currentDate.getTime()
    : Math.min(targetDate.getTime() - currentDate.getTime(), 0);
  const absDiff = Math.abs(diffMs);

  for (const { unit, ms } of UNITS) {
    if (absDiff >= ms) {
      const value = Math.round(diffMs / ms);
      return new Intl.RelativeTimeFormat(locale, options).format(value, unit);
    }
  }

  return new Intl.RelativeTimeFormat(locale).format(0, "second");
}

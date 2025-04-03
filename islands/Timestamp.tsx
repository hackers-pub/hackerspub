import { IS_BROWSER } from "fresh/runtime";
import { useEffect, useState } from "preact/hooks";

export interface TimestampProps {
  value: Date;
  locale: string;
  noRelative?: boolean;
  dateStyle?: Intl.DateTimeFormatOptions["dateStyle"];
  timeStyle?: Intl.DateTimeFormatOptions["timeStyle"];
  class?: string;
}

export function Timestamp(
  { value, locale, noRelative, dateStyle, timeStyle, class: cls }:
    TimestampProps,
) {
  const [currentDate, setCurrentDate] = useState(new Date());
  if (!noRelative) {
    // deno-lint-ignore react-rules-of-hooks
    useEffect(() => {
      const timer = setInterval(() => {
        setCurrentDate(new Date());
      }, 1000);

      return () => clearInterval(timer);
    }, []);
  }
  const absTime = value.toLocaleString(locale, {
    dateStyle,
    timeStyle,
  });
  return (
    <time datetime={value.toISOString()} title={absTime} class={cls}>
      {noRelative || !IS_BROWSER
        ? absTime
        : formatRelativeTime(currentDate, value, locale)}
    </time>
  );
}

function formatRelativeTime(
  currentDate: Date,
  targetDate: Date,
  locale: string,
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
): string {
  const DIFF_MS = Math.min(targetDate.getTime() - currentDate.getTime(), 0);
  const ABS_DIFF = Math.abs(DIFF_MS);

  const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
    { unit: "year", ms: 31536000000 }, // 365 days
    { unit: "month", ms: 2628000000 }, // 30 days
    { unit: "week", ms: 604800000 }, // 7 days
    { unit: "day", ms: 86400000 }, // 24 hours
    { unit: "hour", ms: 3600000 }, // 60 minutes
    { unit: "minute", ms: 60000 }, // 60 seconds
    { unit: "second", ms: 1000 },
  ];

  for (const { unit, ms } of UNITS) {
    if (ABS_DIFF >= ms) {
      const value = Math.round(DIFF_MS / ms);
      return new Intl.RelativeTimeFormat(locale, options).format(value, unit);
    }
  }

  return new Intl.RelativeTimeFormat(locale).format(0, "second");
}

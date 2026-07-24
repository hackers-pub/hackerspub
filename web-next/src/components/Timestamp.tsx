import { createMemo, createSignal, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import { useLingui } from "~/lib/i18n/macro.ts";

export interface TimestampProps {
  value: Date | string;
  capitalizeFirstLetter?: boolean;
  allowFuture?: boolean;
  relativeStyle?: Intl.RelativeTimeFormatStyle;
}

export function Timestamp(props: TimestampProps) {
  const { i18n } = useLingui();
  const date = createMemo(() => new Date(props.value));
  const [currentDate, setCurrentDate] = createSignal(new Date());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const scheduleNextUpdate = () => {
    if (disposed) return;
    timeout = setTimeout(
      () => {
        setCurrentDate(new Date());
        scheduleNextUpdate();
      },
      getRelativeTimeUpdateDelayMs(currentDate(), date(), props.allowFuture),
    );
  };

  if (!isServer) {
    scheduleNextUpdate();
    onCleanup(() => {
      disposed = true;
      if (timeout != null) clearTimeout(timeout);
    });
  }

  return (
    <time
      datetime={date().toISOString()}
      title={date().toLocaleString(i18n.locale, {
        dateStyle: "full",
        timeStyle: "full",
      })}
    >
      {formatRelativeTime(currentDate(), date(), i18n.locale, {
        capitalizeFirstLetter: props.capitalizeFirstLetter,
        allowFuture: props.allowFuture,
        style: props.relativeStyle,
      })}
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

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30.4166666667 * DAY;
const YEAR = 365 * DAY;

export function getRelativeTimeUpdateDelayMs(
  currentDate: Date,
  targetDate: Date,
  allowFuture = false,
): number {
  const diffMs = allowFuture
    ? targetDate.getTime() - currentDate.getTime()
    : Math.min(targetDate.getTime() - currentDate.getTime(), 0);
  const absDiff = Math.abs(diffMs);

  // Most timestamps on timelines are old enough that per-second updates only
  // create browser work without changing the rendered relative time.
  if (absDiff < MINUTE) return SECOND;
  if (absDiff < HOUR) return 30 * SECOND;
  if (absDiff < DAY) return MINUTE;
  if (absDiff < WEEK) return 15 * MINUTE;
  if (absDiff < MONTH) return HOUR;
  if (absDiff < YEAR) return 6 * HOUR;
  return DAY;
}

function formatRelativeTime(
  currentDate: Date,
  targetDate: Date,
  locale: string,
  options: Intl.RelativeTimeFormatOptions & {
    allowFuture?: boolean;
    capitalizeFirstLetter?: boolean;
  } = {
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
      const f = new Intl.RelativeTimeFormat(locale, options).format(
        value,
        unit,
      );
      return options.capitalizeFirstLetter
        ? f.charAt(0).toUpperCase() + f.slice(1)
        : f;
    }
  }
  const f = new Intl.RelativeTimeFormat(locale).format(0, "second");
  return options.capitalizeFirstLetter
    ? f.charAt(0).toUpperCase() + f.slice(1)
    : f;
}

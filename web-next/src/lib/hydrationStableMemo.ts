import { type Accessor, createSignal, onMount } from "solid-js";

type MountRegistrar = (callback: () => void) => void;

/**
 * Holds the source's first-read value, including `null`, `undefined`, and
 * `false`, until `onMount` marks hydration complete.  After mount it returns
 * the live value.
 *
 * Use this only for values whose SSR shape must remain fixed through
 * hydration.  Do not wrap sources that intentionally populate during
 * hydration, because their initial empty value will remain visible until
 * mount.  Capture happens on the first read, not when this helper is created.
 */
export function createHydrationStableMemo<T>(
  source: Accessor<T>,
  registerMount: MountRegistrar = onMount,
): Accessor<T> {
  const [mounted, setMounted] = createSignal(false);
  let captured = false;
  let hydrationValue: T;

  registerMount(() => setMounted(true));

  return () => {
    const value = source();
    if (!captured) {
      hydrationValue = value;
      captured = true;
    }
    return mounted() ? value : hydrationValue;
  };
}

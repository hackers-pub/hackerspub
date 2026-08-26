import { assertEquals } from "@std/assert";
import { createRoot, createSignal } from "solid-js";
import test from "node:test";
import { createHydrationStableMemo } from "./hydrationStableMemo.ts";

test("createHydrationStableMemo holds its first value until mount", () => {
  createRoot((dispose) => {
    const [source, setSource] = createSignal("server");
    let mounted: (() => void) | undefined;
    const stable = createHydrationStableMemo(source, (callback) => {
      mounted = callback;
    });

    assertEquals(stable(), "server");
    setSource("hydrating client");
    assertEquals(stable(), "server");

    mounted?.();
    assertEquals(stable(), "hydrating client");

    setSource("live client");
    assertEquals(stable(), "live client");
    dispose();
  });
});

test("createHydrationStableMemo holds a falsy first value until mount", () => {
  createRoot((dispose) => {
    const [source, setSource] = createSignal<boolean | null>(null);
    let mounted: (() => void) | undefined;
    const stable = createHydrationStableMemo(source, (callback) => {
      mounted = callback;
    });

    assertEquals(stable(), null);
    setSource(true);
    assertEquals(stable(), null);

    mounted?.();
    assertEquals(stable(), true);
    dispose();
  });
});

test("createHydrationStableMemo captures live data when first read after mount", () => {
  createRoot((dispose) => {
    const [source, setSource] = createSignal("initial");
    let mounted: (() => void) | undefined;
    const stable = createHydrationStableMemo(source, (callback) => {
      mounted = callback;
    });

    setSource("before mount");
    mounted?.();
    assertEquals(stable(), "before mount");

    setSource("live");
    assertEquals(stable(), "live");
    dispose();
  });
});

import { assertEquals } from "@std/assert";
import plugin from "./keyed-show.ts";

const RULE = "hackerspub-solid/show-keyed-on-fn-child";

function lint(source: string) {
  return Deno.lint.runPlugin(plugin, "test.tsx", source);
}

Deno.test("flags non-keyed Show with arrow fn child", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={data().actorByHandle}>
          {(actor) => <div>{actor().name}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("does not flag already-keyed Show", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show keyed when={data().actorByHandle}>
          {(actor) => <div>{actor.name}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag Show whose child is not a function", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          <div>plain JSX child</div>
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag Show with zero-arity function child", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {() => <div>no params</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("flags non-keyed Match with function child", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Switch>
          <Match when={cond()}>
            {(value) => <div>{value()}</div>}
          </Match>
        </Switch>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("autofix adds keyed and rewrites bare param() calls", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={data().actorByHandle}>
          {(actor) => (
            <div>
              <a href={actor().url}>{actor().name}</a>
            </div>
          )}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  const fix = diagnostics[0].fix;
  assertEquals(Array.isArray(fix), true);
  // Expect 1 insert (keyed) + 2 replacements (actor() -> actor).
  assertEquals(fix!.length, 3);
});

Deno.test(
  "autofix skips param() calls inside nested fn that rebinds the name",
  () => {
    const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(actor) => (
            <For each={items()}>
              {(actor) => <span>{actor()}</span>}
            </For>
          )}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    const fix = diagnostics[0].fix;
    // Only the "keyed" insertion — the inner actor() belongs to the nested
    // For callback that re-binds the same name.
    assertEquals(fix!.length, 1);
  },
);

Deno.test("autofix preserves param() calls passing arguments", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(value) => <div>{value(1)}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  const fix = diagnostics[0].fix;
  // Only the "keyed" insertion — value(1) is not a bare call.
  assertEquals(fix!.length, 1);
});

Deno.test("flags but does not rewrite calls when param is destructured", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {({ name }) => <div>{name}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  const fix = diagnostics[0].fix;
  // Only the "keyed" insertion; we don't try to rewrite destructured params.
  assertEquals(fix!.length, 1);
});

Deno.test("flags but does not rewrite when body has a const shadowing", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(value) => {
            const value = compute();
            return <div>{value()}</div>;
          }}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  // Only the "keyed" insertion; the body has a same-name const shadowing.
  assertEquals(diagnostics[0].fix!.length, 1);
});

Deno.test("flags but does not rewrite when body has a let shadowing", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(value) => {
            let value;
            return <div>{value}</div>;
          }}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].fix!.length, 1);
});

Deno.test(
  "flags but does not rewrite when catch clause shadows the param",
  () => {
    const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(value) => {
            try { run(); } catch (value) { console.log(value()); }
            return <div>{value()}</div>;
          }}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    // Only "keyed"; both value() calls are unsafe to rewrite mechanically.
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test(
  "flags Show with keyed={false} but does not autofix",
  () => {
    const diagnostics = lint(`
    function App() {
      return (
        <Show keyed={false} when={cond()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
    // No autofix when there's an existing non-truthy `keyed` attribute —
    // we don't want to produce `<Show keyed keyed={false}>`.
    // No autofix is exposed when there's an existing non-truthy `keyed`
    // attribute: the runtime returns an empty fix list.
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test(
  "flags Show with keyed={someVar} but does not autofix",
  () => {
    const diagnostics = lint(`
    function App() {
      return (
        <Show keyed={isKeyed} when={cond()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    // No autofix is exposed when there's an existing non-truthy `keyed`
    // attribute: the runtime returns an empty fix list.
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test(
  "flags but does not rewrite when class static block shadows the param",
  () => {
    const diagnostics = lint(`
    function App() {
      return (
        <Show when={cond()}>
          {(value) => {
            class C {
              static {
                const value = 1;
                console.log(value);
              }
            }
            return <div>{value()}</div>;
          }}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    // Only "keyed"; the static block contains a same-name binding.
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test("does not flag Show with keyed={true}", () => {
  const diagnostics = lint(`
    function App() {
      return (
        <Show keyed={true} when={cond()}>
          {(value) => <div>{value.name}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

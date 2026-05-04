import { assertEquals } from "@std/assert";
import plugin from "./keyed-show.ts";

const RULE = "hackerspub-solid/show-keyed-on-fn-child";

function lint(source: string) {
  return Deno.lint.runPlugin(plugin, "test.tsx", source);
}

// Helper: most fixtures wrap their JSX in a function that declares a
// solid-relay primitive — the rule only fires when the gated value can be
// traced to one of those primitives.
const RELAY_PRELUDE = `
  import { createPreloadedQuery, createFragment } from "solid-relay";
  declare const env: unknown;
  declare const Q: unknown;
  declare function loadQuery(...args: unknown[]): unknown;
`;

Deno.test("flags non-keyed Show on Relay-backed value", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App(props: { $x: unknown }) {
      const data = createPreloadedQuery(env, () => loadQuery());
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

Deno.test("does NOT flag non-keyed Show on a plain Solid signal", () => {
  const diagnostics = lint(`
    import { createSignal } from "solid-js";
    function App() {
      const [value, _setValue] = createSignal();
      return (
        <Show when={value()}>
          {(v) => <div>{v()}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does NOT flag non-keyed Show on a plain identifier", () => {
  const diagnostics = lint(`
    function App(props: { cond: () => unknown }) {
      return (
        <Show when={props.cond()}>
          {(v) => <div>{v()}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag already-keyed Relay-backed Show", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
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
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          <div>plain JSX child</div>
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag Show with zero-arity function child", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {() => <div>no params</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("flags non-keyed Match with function child on Relay value", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Switch>
          <Match when={data()}>
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
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
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
  assertEquals(diagnostics[0].fix!.length, 3);
});

Deno.test(
  "autofix skips param() calls inside nested fn that rebinds the name",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
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
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test("autofix preserves param() calls passing arguments", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {(value) => <div>{value(1)}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].fix!.length, 1);
});

Deno.test(
  "flags but does not rewrite calls when param is destructured",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {({ name }) => <div>{name}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test(
  "flags but does not rewrite when body has a const shadowing",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {(value) => {
            const value = compute();
            return <div>{value()}</div>;
          }}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test(
  "flags but does not rewrite when class static block shadows the param",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {(value) => {
            class C { static { const value = 1; console.log(value); } }
            return <div>{value()}</div>;
          }}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].fix!.length, 1);
  },
);

Deno.test(
  "flags Show with keyed={false} but does not autofix",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show keyed={false} when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test(
  "flags Show with keyed={someVar} but does not autofix",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show keyed={isKeyed} when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test("does not flag Show with keyed={true}", () => {
  const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show keyed={true} when={data()}>
          {(value) => <div>{value.name}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test(
  "propagates Relay-backed-ness through outer keyed Show callback param",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show keyed when={data()}>
          {(d) => (
            <Show when={d.actorByHandle}>
              {(actor) => <div>{actor().name}</div>}
            </Show>
          )}
        </Show>
      );
    }
  `);
    // Inner Show should be flagged: \`d\` is Relay-backed by propagation.
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
  },
);

Deno.test(
  "does not propagate when outer Show is not Relay-backed",
  () => {
    const diagnostics = lint(`
    import { createSignal } from "solid-js";
    function App() {
      const [outer, _set] = createSignal();
      return (
        <Show keyed when={outer()}>
          {(d) => (
            <Show when={d.something}>
              {(thing) => <div>{thing()}</div>}
            </Show>
          )}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test("recognises namespace imports of Relay primitives", () => {
  const diagnostics = lint(`
    import * as relay from "solid-relay";
    declare const env: unknown;
    declare const Q: unknown;
    declare function loadQuery(...args: unknown[]): unknown;
    function App() {
      const data = relay.createFragment(Q, () => null);
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 1);
});

Deno.test("scopes Relay binding to its declaring function", () => {
  // \`data\` declared inside FunctionA must NOT be considered Relay-backed
  // inside FunctionB (separate scope).
  const diagnostics = lint(`${RELAY_PRELUDE}
    function FunctionA() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return null;
    }
    function FunctionB() {
      // No relay primitive bound here.
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

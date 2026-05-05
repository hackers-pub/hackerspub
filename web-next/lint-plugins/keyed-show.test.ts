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
  "suppresses autofix when a nested fn rebinds the param name",
  () => {
    // The outer `actor` param has no calls outside the shadowed inner
    // For callback in this fixture, but the rule can't see that
    // distinction; it conservatively reports without autofix whenever
    // any same-name binder exists in the body, since inserting `keyed`
    // alongside an outer `actor()` call would break at runtime.
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
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test(
  "autofix rewrites optional bare param?.() calls too",
  () => {
    // Without rewriting `value?.()`, the post-fix body would try to
    // call the keyed value (a concrete record) as a function and crash
    // at runtime.
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {(value) => <div>{value?.()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    // 1 keyed insertion + 1 rewrite of value?.() to value.
    assertEquals(diagnostics[0].fix!.length, 2);
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
  "flags but suppresses autofix entirely on const-shadow body",
  () => {
    // Inserting `keyed` while leaving the outer `value()` calls would
    // turn them into runtime calls on a non-function. When we can't
    // safely rewrite the body, we skip the keyed insertion too.
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
    assertEquals(diagnostics[0].fix, []);
  },
);

Deno.test(
  "flags but suppresses autofix entirely on static-block shadow",
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
    assertEquals(diagnostics[0].fix, []);
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

Deno.test(
  "recognises every tracked solid-relay primitive as Relay-backed",
  () => {
    const source = `
    import {
      createPreloadedQuery,
      createFragment,
      createPaginationFragment,
      createRefetchableFragment,
      createLazyLoadQuery,
      createSubscription,
      createQueryLoader,
    } from "solid-relay";
    declare const env: unknown;
    declare const Q: unknown;
    declare function loadQuery(...args: unknown[]): unknown;
    function App() {
      const a = createPreloadedQuery(env, () => loadQuery());
      const b = createFragment(Q, () => null);
      const c = createPaginationFragment(Q, () => null);
      const d = createRefetchableFragment(Q, () => null);
      const e = createLazyLoadQuery(Q, {});
      const f = createSubscription(Q, () => null);
      const g = createQueryLoader(Q);
      return (
        <>
          <Show when={a()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={b()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={c()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={d()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={e()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={f()}>{(v) => <div>{v()}</div>}</Show>
          <Show when={g()}>{(v) => <div>{v()}</div>}</Show>
        </>
      );
    }
  `;
    const diagnostics = lint(source);
    // One diagnostic per non-keyed Show on a Relay-backed value (7 total).
    assertEquals(diagnostics.length, 7);
  },
);

Deno.test(
  "recognises aliased solid-relay imports",
  () => {
    // `import { createFragment as frag } from "solid-relay"` should still
    // be detected even though the local binding is renamed.
    const diagnostics = lint(`
    import { createFragment as frag } from "solid-relay";
    declare const Q: unknown;
    function App() {
      const data = frag(Q, () => null);
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
  },
);

Deno.test(
  "does not flag when a same-named local binding shadows the import",
  () => {
    // The import binding is shadowed by an enclosing function-local
    // const, so the call resolves to the local, not the solid-relay
    // primitive. The rule must not classify `data` as Relay-backed.
    const diagnostics = lint(`${RELAY_PRELUDE}
    declare function compute(): unknown;
    function App() {
      const createFragment = compute;
      const data = createFragment();
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "does not flag when an inner scope shadows an outer Relay binding",
  () => {
    // Outer App has a Relay-backed `data`; inner Inner shadows `data`
    // with a non-Relay value. The Show inside Inner must not be flagged.
    const diagnostics = lint(`${RELAY_PRELUDE}
    declare function compute(): unknown;
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      function Inner() {
        const data = compute();
        return (
          <Show when={data()}>
            {(value) => <div>{value()}</div>}
          </Show>
        );
      }
      return <Inner />;
    }
  `);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "still flags inner Show when outer Relay binding is not shadowed",
  () => {
    // Same shape as above but the inner function does NOT redeclare
    // `data`; the outer Relay binding should still be visible.
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      function Inner() {
        return (
          <Show when={data()}>
            {(value) => <div>{value()}</div>}
          </Show>
        );
      }
      return <Inner />;
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
  },
);

Deno.test(
  "does not flag when an enclosing function param shadows the import",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    declare function compute(): unknown;
    function App({ createFragment }: { createFragment: () => unknown }) {
      const data = createFragment();
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "does not flag a same-named primitive imported from another module",
  () => {
    // A local module exports something named `createFragment`; the rule
    // must not treat its return value as Relay-backed.
    const diagnostics = lint(`
    import { createFragment } from "./my-utils.ts";
    function App() {
      const data = createFragment();
      return (
        <Show when={data()}>
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "flags FunctionExpression children of Relay-backed Show",
  () => {
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {function (value) { return <div>{value()}</div>; }}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
  },
);

Deno.test(
  "flags when a leading zero-arity child precedes the real callback",
  () => {
    // Show has two function children: the first has arity 0 and would
    // be picked up by a naive "first function child" selector. The
    // entry-side selector skips it (requires arity ≥ 1) and records
    // the second; the exit-side selector must use the same filter so
    // shows.get() finds the entry and the diagnostic fires.
    const diagnostics = lint(`${RELAY_PRELUDE}
    function App() {
      const data = createPreloadedQuery(env, () => loadQuery());
      return (
        <Show when={data()}>
          {() => null}
          {(value) => <div>{value()}</div>}
        </Show>
      );
    }
  `);
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0].id, RULE);
  },
);

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

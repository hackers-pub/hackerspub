import { assertEquals } from "@std/assert";
import plugin from "./no-load-query-in-router-query.ts";

const RULE = "hackerspub-solid-relay/no-load-query-in-router-query";

function lint(source: string) {
  return Deno.lint.runPlugin(plugin, "test.tsx", source);
}

Deno.test("flags loadQuery returned from router query fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => loadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags aliased imports", () => {
  const diagnostics = lint(`
    import { query as routerQuery } from "@solidjs/router";
    import { loadQuery as relayLoadQuery } from "solid-relay";

    const loadPageQuery = routerQuery(
      () => relayLoadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags namespace imports", () => {
  const diagnostics = lint(`
    import * as router from "@solidjs/router";
    import * as relay from "solid-relay";

    const loadPageQuery = router.query(
      () => relay.loadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags object spread of loadQuery result", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => ({
        ...loadQuery(env, PageQuery, {}),
        fetchKey: "custom",
      }),
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags named router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    function fetcher() {
      return loadQuery(env, PageQuery, {});
    }

    const loadPageQuery = query(fetcher, "loadPageQuery");
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags named router query fetchers declared later", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(fetcher, "loadPageQuery");

    function fetcher() {
      return loadQuery(env, PageQuery, {});
    }
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags indirect loadQuery calls inside router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const build = () => loadQuery(env, PageQuery, {});

    const loadPageQuery = query(
      () => build(),
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("flags indirect loadQuery calls through nested fetcher helpers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => {
        function build() {
          return loadQuery(env, PageQuery, {});
        }
        return build();
      },
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0].id, RULE);
});

Deno.test("does not flag plain router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";

    const loadPageData = query(
      async () => ({ ok: true }),
      "loadPageData",
    );
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag createPreloadedQuery direct loadQuery source", () => {
  const diagnostics = lint(`
    import { loadQuery, createPreloadedQuery } from "solid-relay";

    const data = createPreloadedQuery(
      PageQuery,
      () => loadQuery(env, PageQuery, {}),
    );
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("does not flag fetchQuery in router query fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { fetchQuery } from "relay-runtime";

    const loadPageData = query(
      () => fetchQuery(env, PageQuery, {}).toPromise(),
      "loadPageData",
    );
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("respects shadowed query binding", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    function setup(query: (fn: unknown, key: string) => unknown) {
      return query(
        () => loadQuery(env, PageQuery, {}),
        "loadPageQuery",
      );
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("respects later shadowed query binding", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    function setup() {
      const loadPageQuery = query(
        () => loadQuery(env, PageQuery, {}),
        "loadPageQuery",
      );
      const query = () => ({ kind: "not router query" });
      return loadPageQuery;
    }
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("respects shadowed loadQuery binding inside fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => {
        const loadQuery = () => ({ kind: "not relay" });
        return loadQuery();
      },
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("respects later shadowed loadQuery binding inside fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => {
        const result = loadQuery(env, PageQuery, {});
        const loadQuery = () => ({ kind: "not relay" });
        return result;
      },
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 0);
});

Deno.test("respects shadowed indirect loadQuery helpers inside fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const build = () => loadQuery(env, PageQuery, {});

    const loadPageQuery = query(
      () => {
        const build = () => ({ kind: "not relay" });
        return build();
      },
      "loadPageQuery",
    );
  `);
  assertEquals(diagnostics.length, 0);
});

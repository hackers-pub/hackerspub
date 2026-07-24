import assert from "node:assert";
import test from "node:test";
import { lintWithOxlint } from "./test-helper.ts";

const RULE = "hackerspub-solid-relay/no-load-query-in-router-query";

function lint(source: string) {
  return lintWithOxlint(RULE, source);
}

test("flags loadQuery returned from router query fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(
      () => loadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags aliased imports", () => {
  const diagnostics = lint(`
    import { query as routerQuery } from "@solidjs/router";
    import { loadQuery as relayLoadQuery } from "solid-relay";

    const loadPageQuery = routerQuery(
      () => relayLoadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags namespace imports", () => {
  const diagnostics = lint(`
    import * as router from "@solidjs/router";
    import * as relay from "solid-relay";

    const loadPageQuery = router.query(
      () => relay.loadQuery(env, PageQuery, {}),
      "loadPageQuery",
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags object spread of loadQuery result", () => {
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
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags named router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    function fetcher() {
      return loadQuery(env, PageQuery, {});
    }

    const loadPageQuery = query(fetcher, "loadPageQuery");
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags named router query fetchers declared later", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const loadPageQuery = query(fetcher, "loadPageQuery");

    function fetcher() {
      return loadQuery(env, PageQuery, {});
    }
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags indirect loadQuery calls inside router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { loadQuery } from "solid-relay";

    const build = () => loadQuery(env, PageQuery, {});

    const loadPageQuery = query(
      () => build(),
      "loadPageQuery",
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags indirect loadQuery calls through nested fetcher helpers", () => {
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
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("does not flag plain router query fetchers", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";

    const loadPageData = query(
      async () => ({ ok: true }),
      "loadPageData",
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does not flag createPreloadedQuery direct loadQuery source", () => {
  const diagnostics = lint(`
    import { loadQuery, createPreloadedQuery } from "solid-relay";

    const data = createPreloadedQuery(
      PageQuery,
      () => loadQuery(env, PageQuery, {}),
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does not flag fetchQuery in router query fetcher", () => {
  const diagnostics = lint(`
    import { query } from "@solidjs/router";
    import { fetchQuery } from "relay-runtime";

    const loadPageData = query(
      () => fetchQuery(env, PageQuery, {}).toPromise(),
      "loadPageData",
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("respects shadowed query binding", () => {
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
  assert.deepEqual(diagnostics.length, 0);
});

test("respects later shadowed query binding", () => {
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
  assert.deepEqual(diagnostics.length, 0);
});

test("respects shadowed loadQuery binding inside fetcher", () => {
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
  assert.deepEqual(diagnostics.length, 0);
});

test("respects later shadowed loadQuery binding inside fetcher", () => {
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
  assert.deepEqual(diagnostics.length, 0);
});

test("respects shadowed indirect loadQuery helpers inside fetcher", () => {
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
  assert.deepEqual(diagnostics.length, 0);
});

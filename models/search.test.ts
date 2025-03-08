import { assertEquals } from "@std/assert/equals";
import { expr, parseQuery, term } from "./search.ts";

Deno.test("term", async (t) => {
  await t.step("quoted keyword", () => {
    assertEquals(term.run('"quoted keyword"'), {
      isError: false,
      index: 16,
      data: null,
      result: { type: "keyword", keyword: "quoted keyword" },
    });
    assertEquals(term.run('"escape\\" sequence\\\\ test"'), {
      isError: false,
      index: 26,
      data: null,
      result: { type: "keyword", keyword: 'escape" sequence\\ test' },
    });
    assertEquals(term.run('"lang:ko"'), {
      isError: false,
      index: 9,
      data: null,
      result: { type: "keyword", keyword: "lang:ko" },
    });
  });

  await t.step("bare keyword", () => {
    assertEquals(term.run("keyword"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
  });

  await t.step("language", () => {
    assertEquals(term.run("lang:ko"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "language", language: "ko" },
    });
    assertEquals(term.run("lang:kor"), {
      isError: false,
      index: 8,
      data: null,
      result: { type: "language", language: "kor" },
    });
    assertEquals(term.run("language:en"), {
      isError: false,
      index: 11,
      data: null,
      result: { type: "language", language: "en" },
    });
    assertEquals(term.run("language:eng"), {
      isError: false,
      index: 12,
      data: null,
      result: { type: "language", language: "eng" },
    });
  });

  await t.step("actor", () => {
    assertEquals(term.run("from:hongminhee"), {
      isError: false,
      index: 15,
      data: null,
      result: { type: "actor", username: "hongminhee", host: undefined },
    });
    assertEquals(term.run("from:@hongminhee"), {
      isError: false,
      index: 16,
      data: null,
      result: { type: "actor", username: "hongminhee", host: undefined },
    });
    assertEquals(term.run("from:hongminhee@hollo.social"), {
      isError: false,
      index: 28,
      data: null,
      result: { type: "actor", username: "hongminhee", host: "hollo.social" },
    });
    assertEquals(term.run("from:@hongminhee@hollo.social"), {
      isError: false,
      index: 29,
      data: null,
      result: { type: "actor", username: "hongminhee", host: "hollo.social" },
    });
  });
});

Deno.test("expr", async (t) => {
  await t.step("not", () => {
    assertEquals(expr.run("-keyword"), {
      isError: false,
      index: 8,
      data: null,
      result: {
        type: "not",
        expr: { type: "keyword", keyword: "keyword" },
      },
    });
    assertEquals(expr.run("-lang:ko"), {
      isError: false,
      index: 8,
      data: null,
      result: {
        type: "not",
        expr: { type: "language", language: "ko" },
      },
    });
    assertEquals(expr.run("-from:hongminhee"), {
      isError: false,
      index: 16,
      data: null,
      result: {
        type: "not",
        expr: { type: "actor", username: "hongminhee", host: undefined },
      },
    });
  });

  await t.step("parentheses", () => {
    assertEquals(expr.run("(keyword)"), {
      isError: false,
      index: 9,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
    assertEquals(expr.run("-(keyword)"), {
      isError: false,
      index: 10,
      data: null,
      result: {
        type: "not",
        expr: { type: "keyword", keyword: "keyword" },
      },
    });
    assertEquals(expr.run("( from:hongminhee lang:ko )"), {
      isError: false,
      index: 27,
      data: null,
      result: {
        type: "and",
        left: { type: "actor", username: "hongminhee", host: undefined },
        right: { type: "language", language: "ko" },
      },
    });
    assertEquals(expr.run("( from:hongminhee OR lang:ko ) keyword"), {
      isError: false,
      index: 38,
      data: null,
      result: {
        type: "and",
        left: {
          type: "or",
          left: { type: "actor", username: "hongminhee", host: undefined },
          right: { type: "language", language: "ko" },
        },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
  });

  await t.step("and", () => {
    assertEquals(expr.run("keyword"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
    assertEquals(expr.run("keyword keyword"), {
      isError: false,
      index: 15,
      data: null,
      result: {
        type: "and",
        left: { type: "keyword", keyword: "keyword" },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
    assertEquals(expr.run("keyword keyword keyword"), {
      isError: false,
      index: 23,
      data: null,
      result: {
        type: "and",
        left: { type: "keyword", keyword: "keyword" },
        right: {
          type: "and",
          left: { type: "keyword", keyword: "keyword" },
          right: { type: "keyword", keyword: "keyword" },
        },
      },
    });
  });

  await t.step("or", () => {
    assertEquals(expr.run("keyword OR keyword"), {
      isError: false,
      index: 18,
      data: null,
      result: {
        type: "or",
        left: { type: "keyword", keyword: "keyword" },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
    assertEquals(expr.run("keyword OR keyword or keyword"), {
      isError: false,
      index: 29,
      data: null,
      result: {
        type: "or",
        left: { type: "keyword", keyword: "keyword" },
        right: {
          type: "or",
          left: { type: "keyword", keyword: "keyword" },
          right: { type: "keyword", keyword: "keyword" },
        },
      },
    });
    assertEquals(expr.run("keyword OR keyword keyword"), {
      isError: false,
      index: 26,
      data: null,
      result: {
        type: "or",
        left: { type: "keyword", keyword: "keyword" },
        right: {
          type: "and",
          left: { type: "keyword", keyword: "keyword" },
          right: { type: "keyword", keyword: "keyword" },
        },
      },
    });
    assertEquals(expr.run("keyword keyword OR keyword"), {
      isError: false,
      index: 26,
      data: null,
      result: {
        type: "or",
        left: {
          type: "and",
          left: { type: "keyword", keyword: "keyword" },
          right: { type: "keyword", keyword: "keyword" },
        },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
  });
});

Deno.test("parseQuery()", () => {
  assertEquals(parseQuery("keyword"), {
    type: "keyword",
    keyword: "keyword",
  });
  assertEquals(parseQuery(" foo -bar "), {
    type: "and",
    left: { type: "keyword", keyword: "foo" },
    right: {
      type: "not",
      expr: { type: "keyword", keyword: "bar" },
    },
  });
});

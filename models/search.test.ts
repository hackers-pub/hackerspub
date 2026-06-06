import assert from "node:assert";
import { describe, it } from "node:test";
import test from "node:test";
import { expr, parseQuery, term } from "./search.ts";

describe("term", () => {
  it("quoted keyword", () => {
    assert.deepEqual(term.run('"quoted keyword"'), {
      isError: false,
      index: 16,
      data: null,
      result: { type: "keyword", keyword: "quoted keyword" },
    });
    assert.deepEqual(term.run('"escape\\" sequence\\\\ test"'), {
      isError: false,
      index: 26,
      data: null,
      result: { type: "keyword", keyword: 'escape" sequence\\ test' },
    });
    assert.deepEqual(term.run('"lang:ko"'), {
      isError: false,
      index: 9,
      data: null,
      result: { type: "keyword", keyword: "lang:ko" },
    });
  });

  it("bare keyword", () => {
    assert.deepEqual(term.run("keyword"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
  });

  it("language", () => {
    assert.deepEqual(term.run("lang:ko"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "language", language: "ko" },
    });
    assert.deepEqual(term.run("lang:kor"), {
      isError: false,
      index: 8,
      data: null,
      result: { type: "language", language: "kor" },
    });
    assert.deepEqual(term.run("language:en"), {
      isError: false,
      index: 11,
      data: null,
      result: { type: "language", language: "en" },
    });
    assert.deepEqual(term.run("language:eng"), {
      isError: false,
      index: 12,
      data: null,
      result: { type: "language", language: "eng" },
    });
  });

  it("actor", () => {
    assert.deepEqual(term.run("from:hongminhee"), {
      isError: false,
      index: 15,
      data: null,
      result: { type: "actor", username: "hongminhee", host: undefined },
    });
    assert.deepEqual(term.run("from:@hongminhee"), {
      isError: false,
      index: 16,
      data: null,
      result: { type: "actor", username: "hongminhee", host: undefined },
    });
    assert.deepEqual(term.run("from:hongminhee@hollo.social"), {
      isError: false,
      index: 28,
      data: null,
      result: { type: "actor", username: "hongminhee", host: "hollo.social" },
    });
    assert.deepEqual(term.run("from:@hongminhee@hollo.social"), {
      isError: false,
      index: 29,
      data: null,
      result: { type: "actor", username: "hongminhee", host: "hollo.social" },
    });
  });
});

describe("expr", () => {
  it("not", () => {
    assert.deepEqual(expr.run("-keyword"), {
      isError: false,
      index: 8,
      data: null,
      result: {
        type: "not",
        expr: { type: "keyword", keyword: "keyword" },
      },
    });
    assert.deepEqual(expr.run("-lang:ko"), {
      isError: false,
      index: 8,
      data: null,
      result: {
        type: "not",
        expr: { type: "language", language: "ko" },
      },
    });
    assert.deepEqual(expr.run("-from:hongminhee"), {
      isError: false,
      index: 16,
      data: null,
      result: {
        type: "not",
        expr: { type: "actor", username: "hongminhee", host: undefined },
      },
    });
  });

  it("parentheses", () => {
    assert.deepEqual(expr.run("(keyword)"), {
      isError: false,
      index: 9,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
    assert.deepEqual(expr.run("-(keyword)"), {
      isError: false,
      index: 10,
      data: null,
      result: {
        type: "not",
        expr: { type: "keyword", keyword: "keyword" },
      },
    });
    assert.deepEqual(expr.run("( from:hongminhee lang:ko )"), {
      isError: false,
      index: 27,
      data: null,
      result: {
        type: "and",
        left: { type: "actor", username: "hongminhee", host: undefined },
        right: { type: "language", language: "ko" },
      },
    });
    assert.deepEqual(expr.run("( from:hongminhee OR lang:ko ) keyword"), {
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

  it("and", () => {
    assert.deepEqual(expr.run("keyword"), {
      isError: false,
      index: 7,
      data: null,
      result: { type: "keyword", keyword: "keyword" },
    });
    assert.deepEqual(expr.run("keyword keyword"), {
      isError: false,
      index: 15,
      data: null,
      result: {
        type: "and",
        left: { type: "keyword", keyword: "keyword" },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
    assert.deepEqual(expr.run("keyword keyword keyword"), {
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

  it("or", () => {
    assert.deepEqual(expr.run("keyword OR keyword"), {
      isError: false,
      index: 18,
      data: null,
      result: {
        type: "or",
        left: { type: "keyword", keyword: "keyword" },
        right: { type: "keyword", keyword: "keyword" },
      },
    });
    assert.deepEqual(expr.run("keyword OR keyword or keyword"), {
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
    assert.deepEqual(expr.run("keyword OR keyword keyword"), {
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
    assert.deepEqual(expr.run("keyword keyword OR keyword"), {
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

test("parseQuery()", () => {
  assert.deepEqual(parseQuery("keyword"), {
    type: "keyword",
    keyword: "keyword",
  });
  assert.deepEqual(parseQuery(" foo -bar "), {
    type: "and",
    left: { type: "keyword", keyword: "foo" },
    right: {
      type: "not",
      expr: { type: "keyword", keyword: "bar" },
    },
  });
});

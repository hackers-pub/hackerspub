import {
  char,
  choice,
  endOfInput,
  exactly,
  letter,
  lookAhead,
  optionalWhitespace,
  type Parser,
  possibly,
  recursiveParser,
  regex,
  sequenceOf,
  startOfInput,
  str,
  whitespace,
} from "arcsecond";
import type { Database, RelationsFilter } from "../db.ts";

export type Term =
  | { type: "keyword"; keyword: string }
  | { type: "language"; language: string }
  | { type: "actor"; username: string; host?: string };

export type Expr =
  | Term
  | { type: "and"; left: Expr; right: Expr }
  | { type: "or"; left: Expr; right: Expr }
  | { type: "not"; expr: Expr };

export const term: Parser<Term> = choice([
  regex(/^\"(?:\\[\\"]|.)+\"/).map<Term>((s) => ({
    type: "keyword",
    keyword: s.slice(1, -1).replace(/\\([\\"])/g, (m) => m[1]),
  })),
  sequenceOf([
    choice([str("lang:"), str("language:")]),
    exactly<string, 2>(2)(letter),
    possibly(letter),
  ]).map<Term>(([_, [l1, l2], l3]) => ({
    type: "language",
    language: l1 + l2 + (l3 ?? ""),
  })),
  sequenceOf([
    choice([str("author:"), str("from:"), str("actor:")]),
    possibly(char("@")),
    regex(/^[^@ \t\v\r\n()]+/),
    possibly(sequenceOf([
      char("@"),
      regex(/^[^ \t\v\r\n()]+/),
    ])),
  ]).map<Term>(([_, __, username, host]) => ({
    type: "actor",
    username,
    host: host?.[1],
  })),
  regex(/^[^ \t\v\r\n()]+/).map<Term>((s) => ({
    type: "keyword",
    keyword: s,
  })),
]);

const exprWithoutOr: Parser<Expr> = recursiveParser(() =>
  sequenceOf([
    choice([
      sequenceOf<string, Term>([
        char("-"),
        term,
      ]).map<Expr>(([_, t]) => ({ type: "not", expr: t })),
      sequenceOf([
        possibly(char("-")),
        char("("),
        optionalWhitespace,
        expr,
        optionalWhitespace,
        char(")"),
      ]).map<Expr>((
        [neg, _, __, e],
      ) => (neg ? { type: "not", expr: e } : e)),
      term,
    ]),
    possibly(sequenceOf<string, string, Expr>([
      whitespace,
      lookAhead(regex(/^(OR[^ \t\v\r\n]|O[^R]|[^O])/i)),
      exprWithoutOr,
    ])),
  ]).map<Expr>(([a, b]) =>
    b == null ? a : { type: "and", left: a, right: b[2] }
  )
);

export const expr: Parser<Expr> = recursiveParser(() =>
  sequenceOf([
    exprWithoutOr,
    possibly(sequenceOf([
      whitespace,
      regex(/^OR/i),
      whitespace,
      expr,
    ])),
  ]).map<Expr>(([a, b]) => b == null ? a : { type: "or", left: a, right: b[3] })
);

const parser = sequenceOf([
  startOfInput,
  optionalWhitespace,
  expr,
  optionalWhitespace,
  endOfInput,
]).map<Expr>(([_, __, e]) => e);

export function parseQuery(input: string): Expr | undefined {
  const result = parser.run(input);
  if (result.isError) return undefined;
  return result.result;
}

export function compileQuery(
  db: Database,
  expr: Expr,
): RelationsFilter<"postTable"> {
  switch (expr.type) {
    case "keyword":
      return { contentHtml: { ilike: `%${expr.keyword}%` } };
    case "language":
      return { language: expr.language };
    case "actor":
      return {
        actor: {
          username: expr.username,
          ...(expr.host == null ? { accountId: { isNotNull: true } } : {
            OR: [
              { instanceHost: expr.host },
              { handleHost: expr.host },
            ],
          }),
        },
      };
    case "and":
      return {
        AND: [
          compileQuery(db, expr.left),
          compileQuery(db, expr.right),
        ],
      };
    case "or":
      return {
        OR: [
          compileQuery(db, expr.left),
          compileQuery(db, expr.right),
        ],
      };
    case "not":
      return { NOT: compileQuery(db, expr.expr) };
  }
}

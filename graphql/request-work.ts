import {
  hasRequestWork,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import {
  defaultFieldResolver,
  type GraphQLOutputType,
  type GraphQLSchema,
  isAbstractType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql";

const instrumented = new WeakSet<GraphQLSchema>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function trackOutput(value: unknown, type: GraphQLOutputType): unknown {
  if (isThenable(value)) {
    return trackRequestWork(
      trackRequestWork(value).then((resolved) => trackOutput(resolved, type)),
    );
  }
  if (isNonNullType(type)) return trackOutput(value, type.ofType);
  if (!isListType(type) || value == null) return value;
  const itemType = type.ofType;
  if (Array.isArray(value)) {
    // Register every already-started array item, even if a non-null failure
    // makes GraphQL stop consuming this list before it reaches that item.
    return value.map((item) => trackOutput(item, itemType));
  }
  if (
    typeof value !== "object" ||
    !(Symbol.iterator in value) ||
    typeof value[Symbol.iterator] !== "function"
  ) {
    return value; // Preserve GraphQL's own invalid-list error.
  }
  const iterable = value as Iterable<unknown>;
  // Preserve one-shot iterators: do not enumerate until GraphQL consumes the
  // list, and never enumerate it a second time for ownership bookkeeping.
  return {
    *[Symbol.iterator]() {
      for (const item of iterable) yield trackOutput(item, itemType);
    },
  };
}

/** Wrap final Pothos resolvers, including its authorization/refetch layers. */
export function instrumentRequestWork(schema: GraphQLSchema): GraphQLSchema {
  if (instrumented.has(schema)) return schema;
  instrumented.add(schema);
  for (const type of Object.values(schema.getTypeMap())) {
    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        const resolve = field.resolve ?? defaultFieldResolver;
        field.resolve = function (source, args, context, info) {
          if (!hasRequestWork()) {
            return resolve.call(this, source, args, context, info);
          }
          throwIfRequestWorkAborted();
          return trackOutput(
            resolve.call(this, source, args, context, info),
            field.type,
          );
        };
      }
      const isTypeOf = type.isTypeOf;
      if (isTypeOf != null) {
        type.isTypeOf = function (value, context, info) {
          if (!hasRequestWork()) {
            return isTypeOf.call(this, value, context, info);
          }
          throwIfRequestWorkAborted();
          const result = isTypeOf.call(this, value, context, info);
          return isThenable(result) ? trackRequestWork(result) : result;
        };
      }
    } else if (isAbstractType(type) && type.resolveType != null) {
      const resolveType = type.resolveType;
      type.resolveType = function (value, context, info, abstractType) {
        if (!hasRequestWork()) {
          return resolveType.call(this, value, context, info, abstractType);
        }
        throwIfRequestWorkAborted();
        const result = resolveType.call(
          this,
          value,
          context,
          info,
          abstractType,
        );
        return isThenable(result) ? trackRequestWork(result) : result;
      };
    }
  }
  return schema;
}

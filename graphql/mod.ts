import type { GraphQLSchema } from "graphql";
import "./account.ts";
import { builder } from "./builder.ts";

export const schema: GraphQLSchema = builder.toSchema();

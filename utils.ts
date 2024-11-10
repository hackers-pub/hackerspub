import { createDefine } from "fresh";
import { Session } from "./models/session.ts";
import { validate as validateUuidV1To5 } from "@std/uuid";
import { validate as validateUuidV7 } from "@std/uuid/unstable-v7";

export interface State {
  session?: Session;
}

export const define = createDefine<State>();

export function validateUuid(string: string): boolean {
  return validateUuidV1To5(string) || validateUuidV7(string);
}

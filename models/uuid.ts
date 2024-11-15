import { validate as validateUuidV1To5 } from "@std/uuid";
import { generate, validate as validateUuidV7 } from "@std/uuid/unstable-v7";

export type Uuid = ReturnType<typeof crypto.randomUUID>;

export function generateUuidV7(): Uuid {
  return generate() as Uuid;
}

export function validateUuid(string: unknown): string is Uuid {
  return typeof string === "string" &&
    (validateUuidV1To5(string) || validateUuidV7(string));
}

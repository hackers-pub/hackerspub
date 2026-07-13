import type Keyv from "keyv";

export let kv: Keyv;

export function configureKeyValue(resource: Keyv): void {
  kv = resource;
}

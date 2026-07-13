import type { createFederationResource } from "@hackerspub/runtime/resources";

type Federation = Awaited<
  ReturnType<typeof createFederationResource>
>["federation"];

export let federation: Federation;
export let ORIGIN: string;

export function configureFederation(
  resource: Federation,
  origin: URL,
): void {
  federation = resource;
  ORIGIN = origin.href;
}

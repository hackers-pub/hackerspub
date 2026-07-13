import type { DriveResource } from "@hackerspub/runtime/resources";

export let drive: DriveResource;

export function configureDrive(resource: DriveResource): void {
  drive = resource;
}

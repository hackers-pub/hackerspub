/// <reference types="@solidjs/start/env" />

declare module "*/messages.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}

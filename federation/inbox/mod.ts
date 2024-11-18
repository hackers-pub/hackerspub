import { Accept } from "@fedify/fedify";
import { captureException } from "@sentry/deno";
import { federation } from "../federation.ts";
import { onFollowAccepted } from "./following.ts";

federation
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .on(Accept, onFollowAccepted)
  .onError((_, error) => void captureException(error));

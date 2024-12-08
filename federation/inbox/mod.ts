import { Accept, Announce, Create, Update } from "@fedify/fedify";
import { captureException } from "@sentry/deno";
import { federation } from "../federation.ts";
import { onFollowAccepted } from "./following.ts";
import { onPostCreated, onPostShared, onPostUpdated } from "./subscribe.ts";

federation
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .on(Accept, onFollowAccepted)
  .on(Create, onPostCreated)
  .on(Announce, onPostShared)
  .on(Update, onPostUpdated)
  .onError((_, error) => void captureException(error));

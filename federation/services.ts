import type { Context } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { FederationServices } from "@hackerspub/models/services";
import {
  getAnnounce,
  getArticle,
  getEmojiReact,
  getEmojiReactId,
  getNote,
  getQuestion,
} from "./objects.ts";
import { sendTagsPubRelayActivity } from "./tags-pub.ts";

export const federationServices: FederationServices<Context<ContextData>> = {
  getAnnounce,
  getArticle,
  getEmojiReact,
  getEmojiReactId,
  getNote,
  getQuestion,
  sendTagsPubRelayActivity,
};

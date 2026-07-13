import type { ApplicationContext } from "@hackerspub/models/context";
import type { FederationServices } from "@hackerspub/models/services";
import { getFedifyContext } from "./context.ts";
import {
  getAnnounce,
  getArticle,
  getEmojiReact,
  getEmojiReactId,
  getNote,
  getQuestion,
} from "./objects.ts";
import {
  sendTagsPubRelayActivity,
  subscribeTagsPubHashtag,
  unsubscribeTagsPubHashtag,
} from "./tags-pub.ts";

export const federationServices: FederationServices<ApplicationContext> = {
  subscribeTagsPubHashtag: (context, tag) =>
    subscribeTagsPubHashtag(getFedifyContext(context), tag),
  unsubscribeTagsPubHashtag: (context, tag) =>
    unsubscribeTagsPubHashtag(getFedifyContext(context), tag),
  getAnnounce: (context, share) =>
    getAnnounce(getFedifyContext(context), share),
  getArticle: (context, articleSource) =>
    getArticle(getFedifyContext(context), articleSource),
  getEmojiReact: (context, reaction) =>
    getEmojiReact(getFedifyContext(context), reaction),
  getEmojiReactId: (context, accountId, postId, emoji) =>
    getEmojiReactId(getFedifyContext(context), accountId, postId, emoji),
  getNote: (context, note, relations) =>
    getNote(getFedifyContext(context), note, relations),
  getQuestion: (context, note, poll, relations) =>
    getQuestion(getFedifyContext(context), note, poll, relations),
  sendTagsPubRelayActivity: (context, accountId, activity, options) =>
    sendTagsPubRelayActivity(
      getFedifyContext(context),
      accountId,
      activity,
      options,
    ),
};

import { getDocumentLoader } from "@fedify/fedify";
import { quoteInteraction } from "@fedify/interaction-controls";
import type { ApplicationContext } from "@hackerspub/models/context";
import type { FederationServices } from "@hackerspub/models/services";
import { sendArticleRelayActivity } from "./article-relay.ts";
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
  evaluateQuotePolicy: async (
    context,
    subject,
    requester,
    matchesApprovalCollection,
  ) =>
    (
      await quoteInteraction.evaluatePolicy(getFedifyContext(context), {
        subject,
        requester,
        matchesApprovalCollection,
      })
    ).result,
  verifyQuoteAuthorization: async (
    context,
    authorization,
    interactingObject,
    interactionTarget,
    attributedTo,
    documentLoader,
    contextLoader,
  ) =>
    (
      await quoteInteraction.verifyAuthorization(getFedifyContext(context), {
        authorization,
        interactingObject,
        interactionTarget,
        attributedTo,
        documentLoader,
        contextLoader: contextLoader ?? getDocumentLoader(),
      })
    ).verified,
  verifyStoredQuoteAuthorization: async (context, authorization, options) =>
    (
      await quoteInteraction.verifyAuthorization(getFedifyContext(context), {
        authorization,
        authorizationId: options.authorizationId,
        interactingObject: options.interactingObject,
        interactionTarget: options.interactionTarget,
        attributedTo: options.attributedTo,
        // Stored, unrevoked grants authenticate aliases independently of origin.
        allowOffOrigin: true,
        verifyAuthenticity: () => options.authentic,
      })
    ).verified,
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
  sendArticleRelayActivity: (context, accountId, activity, options) =>
    sendArticleRelayActivity(
      getFedifyContext(context),
      accountId,
      activity,
      options,
    ),
};

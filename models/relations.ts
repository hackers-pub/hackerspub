import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  accountTable: {
    emails: r.many.accountEmailTable(),
    passkeys: r.many.passkeyTable(),
    keys: r.many.accountKeyTable(),
    links: r.many.accountLinkTable(),
    actor: r.one.actorTable({
      from: r.accountTable.id,
      to: r.actorTable.accountId,
      optional: false,
    }),
    articleDrafts: r.many.articleDraftTable(),
    articleSources: r.many.articleSourceTable(),
    inviter: r.one.accountTable({
      from: r.accountTable.inviterId,
      to: r.accountTable.id,
      alias: "inviter",
    }),
    invitees: r.many.accountTable({
      alias: "inviter",
    }),
    invitationLinks: r.many.invitationLinkTable(),
    notifications: r.many.notificationTable(),
    apnsDeviceTokens: r.many.apnsDeviceTokenTable(),
  },
  accountEmailTable: {
    account: r.one.accountTable({
      from: r.accountEmailTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
  },
  passkeyTable: {
    account: r.one.accountTable({
      from: r.passkeyTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
  },
  accountKeyTable: {
    account: r.one.accountTable({
      from: r.accountKeyTable.accountId,
      to: r.accountTable.id,
    }),
  },
  accountLinkTable: {
    account: r.one.accountTable({
      from: r.accountLinkTable.accountId,
      to: r.accountTable.id,
    }),
  },
  actorTable: {
    instance: r.one.instanceTable({
      from: r.actorTable.instanceHost,
      to: r.instanceTable.host,
      optional: false,
    }),
    account: r.one.accountTable({
      from: r.actorTable.accountId,
      to: r.accountTable.id,
    }),
    successor: r.one.actorTable({
      from: r.actorTable.successorId,
      to: r.actorTable.id,
    }),
    followers: r.many.followingTable({ alias: "followee" }),
    followees: r.many.followingTable({ alias: "follower" }),
    blockers: r.many.blockingTable({ alias: "blockee" }),
    blockees: r.many.blockingTable({ alias: "blocker" }),
    mentions: r.many.mentionTable(),
    posts: r.many.postTable(),
    pins: r.many.pinTable(),
    votedPolls: r.many.pollTable(),
  },
  followingTable: {
    follower: r.one.actorTable({
      alias: "follower",
      from: r.followingTable.followerId,
      to: r.actorTable.id,
      optional: false,
    }),
    followee: r.one.actorTable({
      alias: "followee",
      from: r.followingTable.followeeId,
      to: r.actorTable.id,
      optional: false,
    }),
  },
  blockingTable: {
    blocker: r.one.actorTable({
      alias: "blocker",
      from: r.blockingTable.blockerId,
      to: r.actorTable.id,
      optional: false,
    }),
    blockee: r.one.actorTable({
      alias: "blockee",
      from: r.blockingTable.blockeeId,
      to: r.actorTable.id,
      optional: false,
    }),
  },
  instanceTable: {
    actors: r.many.actorTable(),
  },
  articleDraftTable: {
    account: r.one.accountTable({
      from: r.articleDraftTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
  },
  articleSourceTable: {
    account: r.one.accountTable({
      from: r.articleSourceTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
    post: r.one.postTable({
      from: r.articleSourceTable.id,
      to: r.postTable.articleSourceId,
      optional: false,
    }),
    contents: r.many.articleContentTable(),
  },
  articleContentTable: {
    source: r.one.articleSourceTable({
      from: r.articleContentTable.sourceId,
      to: r.articleSourceTable.id,
      optional: false,
    }),
    original: r.one.articleContentTable({
      from: [
        r.articleContentTable.sourceId,
        r.articleContentTable.originalLanguage,
      ],
      to: [r.articleContentTable.sourceId, r.articleContentTable.language],
      optional: true,
    }),
    translator: r.one.accountTable({
      from: r.articleContentTable.translatorId,
      to: r.accountTable.id,
      optional: true,
    }),
    translationRequester: r.one.accountTable({
      from: r.articleContentTable.translationRequesterId,
      to: r.accountTable.id,
      optional: true,
    }),
  },
  noteSourceTable: {
    account: r.one.accountTable({
      from: r.noteSourceTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
    post: r.one.postTable({
      from: r.noteSourceTable.id,
      to: r.postTable.noteSourceId,
      optional: false,
    }),
    media: r.many.noteMediumTable(),
  },
  noteMediumTable: {
    source: r.one.noteSourceTable({
      from: r.noteMediumTable.sourceId,
      to: r.noteSourceTable.id,
    }),
  },
  postTable: {
    actor: r.one.actorTable({
      from: r.postTable.actorId,
      to: r.actorTable.id,
      optional: false,
    }),
    articleSource: r.one.articleSourceTable({
      from: r.postTable.articleSourceId,
      to: r.articleSourceTable.id,
    }),
    sharedPost: r.one.postTable({
      from: r.postTable.sharedPostId,
      to: r.postTable.id,
      alias: "sharedPost",
    }),
    replyTarget: r.one.postTable({
      from: r.postTable.replyTargetId,
      to: r.postTable.id,
      alias: "replyTarget",
    }),
    quotedPost: r.one.postTable({
      from: r.postTable.quotedPostId,
      to: r.postTable.id,
      alias: "quotedPost",
    }),
    replies: r.many.postTable({ alias: "replyTarget" }),
    shares: r.many.postTable({ alias: "sharedPost" }),
    pins: r.many.pinTable(),
    reactions: r.many.reactionTable(),
    quotes: r.many.postTable({ alias: "quotedPost" }),
    mentions: r.many.mentionTable(),
    media: r.many.postMediumTable(),
    link: r.one.postLinkTable({
      from: r.postTable.linkId,
      to: r.postLinkTable.id,
    }),
    poll: r.one.pollTable({
      from: r.postTable.id,
      to: r.pollTable.postId,
    }),
  },
  pinTable: {
    post: r.one.postTable({
      from: r.pinTable.postId,
      to: r.postTable.id,
      optional: false,
    }),
    actor: r.one.actorTable({
      from: r.pinTable.actorId,
      to: r.actorTable.id,
      optional: false,
    }),
  },
  mentionTable: {
    post: r.one.postTable({
      from: r.mentionTable.postId,
      to: r.postTable.id,
      optional: false,
    }),
    actor: r.one.actorTable({
      from: r.mentionTable.actorId,
      to: r.actorTable.id,
      optional: false,
    }),
  },
  postMediumTable: {
    post: r.one.postTable({
      from: r.postMediumTable.postId,
      to: r.postTable.id,
    }),
  },
  postLinkTable: {
    posts: r.many.postTable(),
    creator: r.one.actorTable({
      from: r.postLinkTable.creatorId,
      to: r.actorTable.id,
    }),
  },
  pollTable: {
    post: r.one.postTable({
      from: r.pollTable.postId,
      to: r.postTable.id,
      optional: false,
    }),
    options: r.many.pollOptionTable(),
    votes: r.many.pollVoteTable(),
    voters: r.many.actorTable({
      from: r.pollTable.postId.through(r.pollVoteTable.postId),
      to: r.actorTable.id.through(r.pollVoteTable.actorId),
    }),
  },
  pollOptionTable: {
    poll: r.one.pollTable({
      from: r.pollOptionTable.postId,
      to: r.pollTable.postId,
      optional: false,
    }),
    votes: r.many.pollVoteTable(),
  },
  pollVoteTable: {
    poll: r.one.pollTable({
      from: r.pollVoteTable.postId,
      to: r.pollTable.postId,
      optional: false,
    }),
    option: r.one.pollOptionTable({
      from: [r.pollVoteTable.postId, r.pollVoteTable.optionIndex],
      to: [r.pollOptionTable.postId, r.pollOptionTable.index],
    }),
    actor: r.one.actorTable({
      from: r.pollVoteTable.actorId,
      to: r.actorTable.id,
      optional: false,
    }),
  },
  reactionTable: {
    post: r.one.postTable({
      from: r.reactionTable.postId,
      to: r.postTable.id,
      optional: false,
    }),
    actor: r.one.actorTable({
      from: r.reactionTable.actorId,
      to: r.actorTable.id,
      optional: false,
    }),
    customEmoji: r.one.customEmojiTable({
      from: r.reactionTable.customEmojiId,
      to: r.customEmojiTable.id,
      optional: true,
    }),
  },
  customEmojiTable: {
    reactions: r.many.reactionTable(),
  },
  timelineItemTable: {
    account: r.one.accountTable({
      from: r.timelineItemTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
    post: r.one.postTable({
      from: r.timelineItemTable.postId,
      to: r.postTable.id,
      optional: false,
    }),
    lastSharer: r.one.actorTable({
      from: r.timelineItemTable.lastSharerId,
      to: r.actorTable.id,
    }),
  },
  apnsDeviceTokenTable: {
    account: r.one.accountTable({
      from: r.apnsDeviceTokenTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
  },
  notificationTable: {
    account: r.one.accountTable({
      from: r.notificationTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
    post: r.one.postTable({
      from: r.notificationTable.postId,
      to: r.postTable.id,
      optional: true,
    }),
    customEmoji: r.one.customEmojiTable({
      from: r.notificationTable.customEmojiId,
      to: r.customEmojiTable.id,
      optional: true,
    }),
  },
  invitationLinkTable: {
    inviter: r.one.accountTable({
      from: r.invitationLinkTable.inviterId,
      to: r.accountTable.id,
      optional: false,
    }),
  },
}));

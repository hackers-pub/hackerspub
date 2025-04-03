import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  accountTable: {
    emails: r.many.accountEmailTable(),
    keys: r.many.accountKeyTable(),
    links: r.many.accountLinkTable(),
    actor: r.one.actorTable({
      from: r.accountTable.id,
      to: r.actorTable.accountId,
      optional: false,
    }),
    articleDrafts: r.many.articleDraftTable(),
    articleSourecs: r.many.articleSourceTable(),
    inviter: r.one.accountTable({
      from: r.accountTable.inviterId,
      to: r.accountTable.id,
      alias: "inviter",
    }),
    invitees: r.many.accountTable({
      alias: "inviter",
    }),
  },
  accountEmailTable: {
    account: r.one.accountTable({
      from: r.accountEmailTable.accountId,
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
    mentions: r.many.mentionTable(),
    posts: r.many.postTable(),
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
    quotes: r.many.postTable({ alias: "quotedPost" }),
    mentions: r.many.mentionTable(),
    media: r.many.postMediumTable(),
    link: r.one.postLinkTable({
      from: r.postTable.linkId,
      to: r.postLinkTable.id,
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
  notificationTable: {
    account: r.one.accountTable({
      from: r.notificationTable.accountId,
      to: r.accountTable.id,
      optional: false,
    }),
    post: r.one.postTable({
      from: r.notificationTable.postId,
      to: r.postTable.id,
    }),
  },
}));

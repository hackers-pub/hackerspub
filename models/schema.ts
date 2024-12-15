import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  json,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { Uuid } from "./uuid.ts";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const allowedEmailTable = pgTable("allowed_email", {
  email: text().notNull().primaryKey(),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type AllowedEmail = typeof allowedEmailTable.$inferSelect;
export type NewAllowedEmail = typeof allowedEmailTable.$inferInsert;

export const accountTable = pgTable(
  "account",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    username: varchar({ length: 50 }).notNull().unique(),
    usernameChanged: timestamp("username_changed", { withTimezone: true }),
    name: varchar({ length: 50 }).notNull(),
    bio: text().notNull(),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "account_username_check",
      sql`${table.username} ~ '^[a-z0-9_]{1,50}$'`,
    ),
    check(
      "account_name_check",
      sql`
        char_length(${table.name}) <= 50 AND
        ${table.name} !~ '^[[:space:]]' AND
        ${table.name} !~ '[[:space:]]$'
      `,
    ),
  ],
);

export type Account = typeof accountTable.$inferSelect;
export type NewAccount = typeof accountTable.$inferInsert;

export const accountRelations = relations(
  accountTable,
  ({ one, many }) => ({
    emails: many(accountEmailTable),
    keys: many(accountKeyTable),
    links: many(accountLinkTable),
    actor: one(actorTable, {
      fields: [accountTable.id],
      references: [actorTable.accountId],
    }),
    articleDrafts: many(articleDraftTable),
    articleSources: many(articleSourceTable),
  }),
);

export const accountEmailTable = pgTable(
  "account_email",
  {
    email: text().notNull().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id),
    public: boolean().notNull().default(false),
    verified: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
);

export type AccountEmail = typeof accountEmailTable.$inferSelect;
export type NewAccountEmail = typeof accountEmailTable.$inferInsert;

export const accountEmailRelations = relations(
  accountEmailTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [accountEmailTable.accountId],
      references: [accountTable.id],
    }),
  }),
);

export const accountKeyTypeEnum = pgEnum("account_key_type", [
  "Ed25519",
  "RSASSA-PKCS1-v1_5",
]);

export type AccountKeyType = (typeof accountKeyTypeEnum.enumValues)[number];

export const accountKeyTable = pgTable(
  "account_key",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id),
    type: accountKeyTypeEnum().notNull(),
    public: jsonb().$type<JsonWebKey>().notNull(),
    private: jsonb().$type<JsonWebKey>().notNull(),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.type] }),
    check(
      "account_key_public_check",
      sql`${table.public} IS JSON OBJECT`,
    ),
    check(
      "account_key_private_check",
      sql`${table.private} IS JSON OBJECT`,
    ),
  ],
);

export type AccountKey = typeof accountKeyTable.$inferSelect;
export type NewAccountKey = typeof accountKeyTable.$inferInsert;

export const accountKeyRelations = relations(
  accountKeyTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [accountKeyTable.accountId],
      references: [accountTable.id],
    }),
  }),
);

export const accountLinkIconEnum = pgEnum("account_link_icon", [
  "activitypub",
  "akkoma",
  "bluesky",
  "codeberg",
  "dev",
  "discord",
  "facebook",
  "github",
  "gitlab",
  "hackernews",
  "hollo",
  "instagram",
  "keybase",
  "lemmy",
  "linkedin",
  "lobsters",
  "mastodon",
  "matrix",
  "misskey",
  "pixelfed",
  "pleroma",
  "qiita",
  "reddit",
  "sourcehut",
  "threads",
  "velog",
  "web",
  "wikipedia",
  "x",
  "zenn",
]);

export type AccountLinkIcon = (typeof accountLinkIconEnum.enumValues)[number];

export const accountLinkTable = pgTable(
  "account_link",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id),
    index: smallint().notNull(),
    name: varchar({ length: 50 }).notNull(),
    url: text().notNull(),
    handle: text(),
    icon: accountLinkIconEnum().notNull().default("web"),
    verified: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.index] }),
    check(
      "account_link_name_check",
      sql`
        char_length(${table.name}) <= 50 AND
        ${table.name} !~ '^[[:space:]]' AND
        ${table.name} !~ '[[:space:]]$'
      `,
    ),
  ],
);

export type AccountLink = typeof accountLinkTable.$inferSelect;
export type NewAccountLink = typeof accountLinkTable.$inferInsert;

export const accountLinkRelations = relations(
  accountLinkTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [accountLinkTable.accountId],
      references: [accountTable.id],
    }),
  }),
);

export const actorTypeEnum = pgEnum("actor_type", [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
]);

export type ActorType = (typeof actorTypeEnum.enumValues)[number];

export const actorTable = pgTable(
  "actor",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    type: actorTypeEnum().notNull(),
    username: text().notNull(),
    instanceHost: text("instance_host")
      .notNull()
      .references(() => instanceTable.host),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .unique()
      .references(() => accountTable.id),
    name: text(),
    bioHtml: text("bio_html"),
    automaticallyApprovesFollowers: boolean("automatically_approves_followers")
      .notNull().default(false),
    avatarUrl: text("avatar_url"),
    headerUrl: text("header_url"),
    inboxUrl: text("inbox_url").notNull(),
    sharedInboxUrl: text("shared_inbox_url"),
    followersUrl: text("followers_url"),
    featuredUrl: text("featured_url"),
    fieldHtmls: json("field_htmls")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    emojis: jsonb().$type<Record<string, string>>().notNull().default({}),
    sensitive: boolean().notNull().default(false),
    successorId: uuid("successor_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "cascade" }),
    aliases: text().array().notNull().default(sql`(ARRAY[]::text[])`),
    followeesCount: integer("followees_count").notNull().default(0),
    followersCount: integer("followers_count").notNull().default(0),
    postsCount: integer("posts_count").notNull().default(0),
    url: text(),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    published: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.username, table.instanceHost),
    check("actor_username_check", sql`${table.username} NOT LIKE '%@%'`),
  ],
);

export type Actor = typeof actorTable.$inferSelect;
export type NewActor = typeof actorTable.$inferInsert;

export const actorRelations = relations(
  actorTable,
  ({ one, many }) => ({
    instance: one(instanceTable, {
      fields: [actorTable.instanceHost],
      references: [instanceTable.host],
    }),
    account: one(accountTable, {
      fields: [actorTable.accountId],
      references: [accountTable.id],
    }),
    successor: one(actorTable, {
      fields: [actorTable.successorId],
      references: [actorTable.id],
    }),
    followers: many(followingTable, { relationName: "followee" }),
    followees: many(followingTable, { relationName: "follower" }),
    mentions: many(mentionTable),
  }),
);

export const followingTable = pgTable(
  "following",
  {
    iri: text().notNull().primaryKey(),
    followerId: uuid("follower_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id),
    followeeId: uuid("followee_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id),
    accepted: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.followerId, table.followeeId),
  ],
);

export type Following = typeof followingTable.$inferSelect;
export type NewFollowing = typeof followingTable.$inferInsert;

export const followingRelations = relations(
  followingTable,
  ({ one }) => ({
    follower: one(actorTable, {
      relationName: "follower",
      fields: [followingTable.followerId],
      references: [actorTable.id],
    }),
    followee: one(actorTable, {
      relationName: "followee",
      fields: [followingTable.followeeId],
      references: [actorTable.id],
    }),
  }),
);

export const instanceTable = pgTable(
  "instance",
  {
    host: text().primaryKey(),
    software: text(),
    softwareVersion: text("software_version"),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "instance_host_check",
      sql`${table.host} NOT LIKE '%@%'`,
    ),
  ],
);

export type Instance = typeof instanceTable.$inferSelect;
export type NewInstance = typeof instanceTable.$inferInsert;

export const instanceRelations = relations(
  instanceTable,
  ({ many }) => ({
    actors: many(actorTable),
  }),
);

export const articleDraftTable = pgTable(
  "article_draft",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id),
    articleSourceId: uuid("article_source_id")
      .$type<Uuid>()
      .references(() => articleSourceTable.id),
    title: text().notNull(),
    content: text().notNull(),
    tags: text().array().notNull().default(sql`(ARRAY[]::text[])`),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
);

export type ArticleDraft = typeof articleDraftTable.$inferSelect;
export type NewArticleDraft = typeof articleDraftTable.$inferInsert;

export const articleDraftRelations = relations(
  articleDraftTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [articleDraftTable.accountId],
      references: [accountTable.id],
    }),
  }),
);

export const articleSourceTable = pgTable(
  "article_source",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id),
    publishedYear: smallint("published_year")
      .notNull()
      .default(sql`EXTRACT(year FROM CURRENT_TIMESTAMP)`),
    slug: varchar({ length: 128 }).notNull(),
    title: text().notNull(),
    content: text().notNull(),
    language: varchar().notNull(),
    tags: text().array().notNull().default(sql`(ARRAY[]::text[])`),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    published: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.accountId, table.publishedYear, table.slug),
    check(
      "article_source_published_year_check",
      sql`${table.publishedYear} = EXTRACT(year FROM ${table.published})`,
    ),
  ],
);

export type ArticleSource = typeof articleSourceTable.$inferSelect;
export type NewArticleSource = typeof articleSourceTable.$inferInsert;

export const articleSourceRelations = relations(
  articleSourceTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [articleSourceTable.accountId],
      references: [accountTable.id],
    }),
    post: one(postTable, {
      fields: [articleSourceTable.id],
      references: [postTable.articleSourceId],
    }),
  }),
);

export const POST_VISIBILITIES = [
  "public",
  "unlisted",
  "followers",
  "direct",
  "none",
] as const;

export const postVisibilityEnum = pgEnum("post_visibility", POST_VISIBILITIES);

export type PostVisibility = (typeof postVisibilityEnum.enumValues)[number];

export const noteSourceTable = pgTable("note_source", {
  id: uuid().$type<Uuid>().primaryKey(),
  accountId: uuid("account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accountTable.id),
  visibility: postVisibilityEnum().notNull().default("public"),
  content: text().notNull(),
  language: varchar().notNull(),
  updated: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  published: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type NoteSource = typeof noteSourceTable.$inferSelect;
export type NewNoteSource = typeof noteSourceTable.$inferInsert;

export const noteSourceRelations = relations(
  noteSourceTable,
  ({ one }) => ({
    account: one(accountTable, {
      fields: [noteSourceTable.accountId],
      references: [accountTable.id],
    }),
    post: one(postTable, {
      fields: [noteSourceTable.id],
      references: [postTable.noteSourceId],
    }),
  }),
);

export const postTypeEnum = pgEnum("post_type", [
  "Article",
  "Note",
  "Question",
]);

export type PostType = (typeof postTypeEnum.enumValues)[number];

export const postTable = pgTable(
  "post",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    type: postTypeEnum().notNull(),
    visibility: postVisibilityEnum().notNull().default("unlisted"),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    articleSourceId: uuid("article_source_id")
      .$type<Uuid>()
      .unique()
      .references(() => articleSourceTable.id, { onDelete: "cascade" }),
    noteSourceId: uuid("note_source_id")
      .$type<Uuid>()
      .unique()
      .references(() => noteSourceTable.id, { onDelete: "cascade" }),
    sharedPostId: uuid("shared_post_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    replyTargetId: uuid("reply_target_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    name: text(),
    contentHtml: text("content_html").notNull(),
    language: varchar(),
    tags: jsonb().$type<Record<string, string>>().notNull().default({}),
    emojis: jsonb().$type<Record<string, string>>().notNull().default({}),
    sensitive: boolean().notNull().default(false),
    repliesCount: integer("replies_count").notNull().default(0),
    likesCount: integer("likes_count").notNull().default(0),
    sharesCount: integer("shares_count").notNull().default(0),
    reactionsCount: jsonb()
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    url: text(),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    published: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "post_article_source_id_check",
      sql`${table.type} = 'Article' OR ${table.articleSourceId} IS NULL`,
    ),
    check(
      "post_note_source_id_check",
      sql`${table.type} = 'Note' OR ${table.noteSourceId} IS NULL`,
    ),
    check(
      "post_shared_post_id_reply_target_id_check",
      sql`${table.sharedPostId} IS NULL OR ${table.replyTargetId} IS NULL`,
    ),
  ],
);

export type Post = typeof postTable.$inferSelect;
export type NewPost = typeof postTable.$inferInsert;

export const postRelations = relations(
  postTable,
  ({ one, many }) => ({
    actor: one(actorTable, {
      fields: [postTable.actorId],
      references: [actorTable.id],
    }),
    articleSource: one(articleSourceTable, {
      fields: [postTable.articleSourceId],
      references: [articleSourceTable.id],
    }),
    sharedPost: one(postTable, {
      fields: [postTable.sharedPostId],
      references: [postTable.id],
      relationName: "sharedPost",
    }),
    replyTarget: one(postTable, {
      fields: [postTable.replyTargetId],
      references: [postTable.id],
      relationName: "replyTarget",
    }),
    replies: many(postTable, { relationName: "replyTarget" }),
    shares: many(postTable, { relationName: "sharedPost" }),
    mentions: many(mentionTable),
  }),
);

export const mentionTable = pgTable(
  "mention",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => postTable.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.actorId] }),
  ],
);

export type Mention = typeof mentionTable.$inferSelect;
export type NewMention = typeof mentionTable.$inferInsert;

export const mentionRelations = relations(
  mentionTable,
  ({ one }) => ({
    post: one(postTable, {
      fields: [mentionTable.postId],
      references: [postTable.id],
    }),
    actor: one(actorTable, {
      fields: [mentionTable.actorId],
      references: [actorTable.id],
    }),
  }),
);

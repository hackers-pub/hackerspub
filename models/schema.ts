import { desc, isNull, type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  bytea,
  check,
  foreignKey,
  index,
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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Locale } from "./i18n.ts";
import type { Uuid } from "./uuid.ts";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const accountTable = pgTable(
  "account",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    username: varchar({ length: 50 }).notNull().unique(),
    oldUsername: varchar("old_username", { length: 50 }),
    usernameChanged: timestamp("username_changed", { withTimezone: true }),
    name: varchar({ length: 50 }).notNull(),
    bio: text().notNull(),
    avatarKey: text("avatar_key").unique(),
    ogImageKey: text("og_image_key").unique(),
    locales: varchar().array().$type<Locale[] | null>(),
    moderator: boolean().notNull().default(false),
    notificationRead: timestamp("notification_read", { withTimezone: true }),
    leftInvitations: smallint("left_invitations").notNull(),
    inviterId: uuid("inviter_id").$type<Uuid | null>().references(
      (): AnyPgColumn => accountTable.id,
      { onDelete: "set null" },
    ),
    hideFromInvitationTree: boolean("hide_from_invitation_tree")
      .notNull()
      .default(false),
    hideForeignLanguages: boolean("hide_foreign_languages")
      .notNull()
      .default(false),
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

export const accountEmailTable = pgTable(
  "account_email",
  {
    email: text().notNull().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    public: boolean().notNull().default(false),
    verified: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
);

export type AccountEmail = typeof accountEmailTable.$inferSelect;
export type NewAccountEmail = typeof accountEmailTable.$inferInsert;

export const passkeyDeviceTypeEnum = pgEnum("passkey_device_type", [
  "singleDevice",
  "multiDevice",
]);

export type PasskeyDeviceType =
  (typeof passkeyDeviceTypeEnum.enumValues)[number];

export const passkeyTransportEnum = pgEnum("passkey_transport", [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export type PasskeyTransport = (typeof passkeyTransportEnum.enumValues)[number];

export const passkeyTable = pgTable(
  "passkey",
  {
    id: text().notNull().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    publicKey: bytea("public_key").notNull(),
    webauthnUserId: text("webauthn_user_id").notNull(),
    counter: bigint({ mode: "bigint" }).notNull(),
    deviceType: passkeyDeviceTypeEnum("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: passkeyTransportEnum("transports")
      .array()
      .$type<PasskeyTransport[]>(),
    lastUsed: timestamp("last_used", { withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.accountId),
    index().on(table.webauthnUserId),
    unique().on(table.accountId, table.webauthnUserId),
    check("passkey_name_check", sql`${table.name} !~ '^[[:space:]]*$'`),
  ],
);

export type Passkey = typeof passkeyTable.$inferSelect;
export type NewPasskey = typeof passkeyTable.$inferInsert;

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
      .references(() => accountTable.id, { onDelete: "cascade" }),
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
      .references(() => accountTable.id, { onDelete: "cascade" }),
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
    handleHost: text("handle_host").notNull(),
    handle: text().notNull().generatedAlwaysAs((): SQL =>
      sql`'@' || ${actorTable.username} || '@' || ${actorTable.handleHost}`
    ),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .unique()
      .references(() => accountTable.id, { onDelete: "cascade" }),
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
    tags: jsonb().$type<Record<string, string>>().notNull().default({}),
    sensitive: boolean().notNull().default(false),
    successorId: uuid("successor_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "set null" }),
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

export const followingTable = pgTable(
  "following",
  {
    iri: text().notNull().primaryKey(),
    followerId: uuid("follower_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    accepted: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.followerId, table.followeeId),
    index().on(table.followerId),
  ],
);

export type Following = typeof followingTable.$inferSelect;
export type NewFollowing = typeof followingTable.$inferInsert;

export const blockingTable = pgTable(
  "blocking",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    blockerId: uuid("blocker_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    blockeeId: uuid("blockee_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.blockerId, table.blockeeId),
    check(
      "blocking_blocker_blockee_check",
      sql`${table.blockerId} != ${table.blockeeId}`,
    ),
  ],
);

export type Blocking = typeof blockingTable.$inferSelect;
export type NewBlocking = typeof blockingTable.$inferInsert;

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

export const articleDraftTable = pgTable(
  "article_draft",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    articleSourceId: uuid("article_source_id")
      .$type<Uuid>()
      .references(() => articleSourceTable.id, { onDelete: "cascade" }),
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

export const articleSourceTable = pgTable(
  "article_source",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    publishedYear: smallint("published_year")
      .notNull()
      .default(sql`EXTRACT(year FROM CURRENT_TIMESTAMP)`),
    slug: varchar({ length: 128 }).notNull(),
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

export const articleContentTable = pgTable(
  "article_content",
  {
    sourceId: uuid("source_id")
      .$type<Uuid>()
      .notNull()
      .references(() => articleSourceTable.id, { onDelete: "cascade" }),
    language: varchar().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    ogImageKey: text("og_image_key").unique(),
    originalLanguage: varchar("original_language"),
    translatorId: uuid("translator_id")
      .$type<Uuid>()
      .references(() => accountTable.id, { onDelete: "set null" }),
    translationRequesterId: uuid("translation_requester_id")
      .$type<Uuid>()
      .references(() => accountTable.id, { onDelete: "set null" }),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    published: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.language] }),
    foreignKey({
      columns: [table.sourceId, table.originalLanguage],
      foreignColumns: [table.sourceId, table.language],
    }).onDelete("cascade"),
    check(
      "article_content_original_language_check",
      sql`(
        ${table.translatorId} IS NULL AND
        ${table.translationRequesterId} IS NULL
      ) = (${table.originalLanguage} IS NULL)`,
    ),
    check(
      "article_content_translator_translation_requester_id_check",
      sql`${table.translatorId} IS NULL OR ${table.translationRequesterId} IS NULL`,
    ),
  ],
);

export type ArticleContent = typeof articleContentTable.$inferSelect;
export type NewArticleContent = typeof articleContentTable.$inferInsert;

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
    .references(() => accountTable.id, { onDelete: "cascade" }),
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

export const noteMediumTable = pgTable(
  "note_medium",
  {
    sourceId: uuid("note_source_id")
      .$type<Uuid>()
      .notNull()
      .references(() => noteSourceTable.id, { onDelete: "cascade" }),
    index: smallint().notNull(),
    key: text().notNull().unique(),
    alt: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.index] }),
  ],
);

export type NoteMedium = typeof noteMediumTable.$inferSelect;
export type NewNoteMedium = typeof noteMediumTable.$inferInsert;

export const postTypeEnum = pgEnum("post_type", [
  "Article",
  "Note",
  "Question",
]);

export type PostType = (typeof postTypeEnum.enumValues)[number];

export type Emoji = string; // TODO: use a better type

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
      .references((): AnyPgColumn => postTable.id, { onDelete: "set null" }),
    quotedPostId: uuid("quoted_post_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "set null" }),
    name: text(),
    summary: text(),
    contentHtml: text("content_html").notNull(),
    language: varchar(),
    tags: jsonb().$type<Record<string, string>>().notNull().default({}),
    emojis: jsonb().$type<Record<string, string>>().notNull().default({}),
    sensitive: boolean().notNull().default(false),
    repliesCount: integer("replies_count").notNull().default(0),
    sharesCount: integer("shares_count").notNull().default(0),
    quotesCount: integer("quotes_count").notNull().default(0),
    reactionsCounts: jsonb("reactions_counts")
      .$type<Record<Emoji | Uuid, number>>()
      .notNull()
      .default({}),
    reactionsCount: integer("reactions_count").notNull().generatedAlwaysAs(
      (): SQL => sql`json_sum_object_values(${postTable.reactionsCounts})`,
    ),
    linkId: uuid("link_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postLinkTable.id, {
        onDelete: "restrict",
      }),
    linkUrl: text("link_url"),
    url: text(),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    published: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.id, table.actorId),
    unique().on(table.actorId, table.sharedPostId),
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
    check(
      "post_reactions_acounts_check",
      sql`${table.reactionsCounts} IS JSON OBJECT`,
    ),
    check(
      "post_link_id_check",
      sql`(${table.linkId} IS NULL) = (${table.linkUrl} IS NULL)`,
    ),
    index("idx_post_visibility_published")
      .on(table.visibility, desc(table.published)),
    index("idx_post_actor_id_published")
      .on(table.actorId, desc(table.published)),
    index().on(table.replyTargetId),
  ],
);

export type Post = typeof postTable.$inferSelect;
export type NewPost = typeof postTable.$inferInsert;

export const pinTable = pgTable(
  "pin",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull(),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.actorId] }),
    foreignKey({
      columns: [table.postId, table.actorId],
      foreignColumns: [postTable.id, postTable.actorId],
    }).onDelete("cascade"),
    index().on(table.actorId),
  ],
);

export type Pin = typeof pinTable.$inferSelect;
export type NewPin = typeof pinTable.$inferInsert;

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
    index().on(table.actorId),
  ],
);

export type Mention = typeof mentionTable.$inferSelect;
export type NewMention = typeof mentionTable.$inferInsert;

export const postMediumTypeEnum = pgEnum("post_medium_type", [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export type PostMediumType = (typeof postMediumTypeEnum.enumValues)[number];

export function isPostMediumType(value: unknown): value is PostMediumType {
  return postMediumTypeEnum.enumValues.includes(value as PostMediumType);
}

export const postMediumTable = pgTable(
  "post_medium",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => postTable.id, { onDelete: "cascade" }),
    index: smallint().notNull(),
    type: postMediumTypeEnum().notNull(),
    url: text().notNull(),
    alt: text(),
    width: integer(),
    height: integer(),
    thumbnailKey: text("thumbnail_key").unique(),
    sensitive: boolean().notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.index] }),
    check("post_medium_index_check", sql`${table.index} >= 0`),
    check("post_medium_url_check", sql`${table.url} ~ '^https?://'`),
    check(
      "post_medium_width_height_check",
      sql`
        CASE
          WHEN ${table.width} IS NULL THEN ${table.height} IS NULL
          ELSE ${table.height} IS NOT NULL AND
               ${table.width} > 0 AND ${table.height} > 0
        END
      `,
    ),
  ],
);

export type PostMedium = typeof postMediumTable.$inferSelect;
export type NewPostMedium = typeof postMediumTable.$inferInsert;

export const postLinkTable = pgTable(
  "post_link",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    url: text().notNull().unique(),
    title: text(),
    siteName: text("site_name"),
    type: text(),
    description: text(),
    author: text(),
    imageUrl: text("image_url"),
    imageAlt: text("image_alt"),
    imageType: text("image_type"),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),
    creatorId: uuid("creator_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "set null" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    scraped: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "post_link_url_check",
      sql`${table.url} ~ '^https?://'`,
    ),
    check(
      "post_link_image_url_check",
      sql`${table.imageUrl} ~ '^https?://'`,
    ),
    check(
      "post_link_image_alt_check",
      sql`${table.imageAlt} IS NULL OR ${table.imageUrl} IS NOT NULL`,
    ),
    check(
      "post_link_image_type_check",
      sql`
        CASE
          WHEN ${table.imageType} IS NULL THEN true
          ELSE ${table.imageType} ~ '^image/' AND
               ${table.imageUrl} IS NOT NULL
        END
      `,
    ),
    check(
      "post_link_image_width_height_check",
      sql`
        CASE
          WHEN ${table.imageWidth} IS NOT NULL
          THEN ${table.imageUrl} IS NOT NULL AND
                 ${table.imageHeight} IS NOT NULL AND
                 ${table.imageWidth} > 0 AND
                 ${table.imageHeight} > 0
          WHEN ${table.imageHeight} IS NOT NULL
          THEN ${table.imageUrl} IS NOT NULL AND
               ${table.imageWidth} IS NOT NULL AND
               ${table.imageWidth} > 0 AND
               ${table.imageHeight} > 0
          ELSE true
        END
      `,
    ),
    index().on(table.creatorId),
  ],
);

export type PostLink = typeof postLinkTable.$inferSelect;
export type NewPostLink = typeof postLinkTable.$inferInsert;

export const pollTable = pgTable(
  "poll",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .primaryKey()
      .references(() => postTable.id, { onDelete: "cascade" }),
    multiple: boolean().notNull(),
    votersCount: integer("voters_count").notNull().default(0),
    ends: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    check("poll_voters_count_check", sql`${table.votersCount} >= 0`),
  ],
);

export type Poll = typeof pollTable.$inferSelect;
export type NewPoll = typeof pollTable.$inferInsert;

export const pollOptionTable = pgTable(
  "poll_option",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => pollTable.postId, { onDelete: "cascade" }),
    index: smallint().notNull(),
    title: text().notNull(),
    votesCount: integer("votes_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.index] }),
    unique().on(table.postId, table.title),
    check("poll_option_index_check", sql`${table.index} >= 0`),
    check("poll_option_votes_count_check", sql`${table.votesCount} >= 0`),
  ],
);

export type PollOption = typeof pollOptionTable.$inferSelect;
export type NewPollOption = typeof pollOptionTable.$inferInsert;

export const pollVoteTable = pgTable(
  "poll_vote",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => pollTable.postId, { onDelete: "cascade" }),
    optionIndex: smallint("option_index").notNull(),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "cascade" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.optionIndex, table.actorId] }),
    foreignKey({
      columns: [table.postId, table.optionIndex],
      foreignColumns: [pollOptionTable.postId, pollOptionTable.index],
    }),
  ],
);

export type PollVote = typeof pollVoteTable.$inferSelect;
export type NewPollVote = typeof pollVoteTable.$inferInsert;

export const reactionTable = pgTable(
  "reaction",
  {
    iri: text().notNull().primaryKey(),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => postTable.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    emoji: text(),
    customEmojiId: uuid("custom_emoji_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => customEmojiTable.id, {
        onDelete: "cascade",
      }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    uniqueIndex()
      .on(table.postId, table.actorId, table.emoji)
      .where(isNull(table.customEmojiId)),
    uniqueIndex()
      .on(table.postId, table.actorId, table.customEmojiId)
      .where(isNull(table.emoji)),
    index().on(table.postId),
    check(
      "reaction_emoji_check",
      sql`
        ${table.emoji} IS NOT NULL
          AND length(${table.emoji}) > 0
          AND ${table.emoji} !~ '^[[:space:]:]+|[[:space:]:]+$'
          AND ${table.customEmojiId} IS NULL
        OR
          ${table.emoji} IS NULL AND ${table.customEmojiId} IS NOT NULL
      `,
    ),
  ],
);

export type Reaction = typeof reactionTable.$inferSelect;
export type NewReaction = typeof reactionTable.$inferInsert;

export const customEmojiTable = pgTable(
  "custom_emoji",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    name: text().notNull(),
    imageType: text("image_type"),
    imageUrl: text("image_url").notNull(),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "custom_emoji_name_check",
      sql`${table.name} ~ '^:[^:[:space:]]+:$'`,
    ),
    check(
      "custom_emoji_image_type_check",
      sql`
        CASE
          WHEN ${table.imageType} IS NULL THEN true
          ELSE ${table.imageType} ~ '^image/'
        END
      `,
    ),
    check(
      "custom_emoji_image_url_check",
      sql`${table.imageUrl} ~ '^https?://'`,
    ),
  ],
);

export type CustomEmoji = typeof customEmojiTable.$inferSelect;
export type NewCustomEmoji = typeof customEmojiTable.$inferInsert;

export const timelineItemTable = pgTable(
  "timeline_item",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    originalAuthorId: uuid("original_author_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "cascade" }),
    lastSharerId: uuid("last_sharer_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "set null" }),
    sharersCount: integer("sharers_count").notNull().default(0),
    added: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    appended: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.postId] }),
    index("idx_timeline_item_account_id_added")
      .on(table.accountId, desc(table.added)),
  ],
);

export type TimelineItem = typeof timelineItemTable.$inferSelect;
export type NewTimelineItem = typeof timelineItemTable.$inferInsert;

export const notificationTypeEnum = pgEnum("notification_type", [
  "follow",
  "mention",
  "reply",
  "share",
  "quote",
  "react",
]);

export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

export const notificationTable = pgTable(
  "notification",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "cascade" }),
    type: notificationTypeEnum().notNull(),
    // For the postId column:
    // - When type is 'follow', this is not used
    // - When type is 'mention', this is the ID of the post containing the mention
    // - When type is 'reply', this is the ID of the reply post
    // - When type is 'share', this is the ID of the shared post
    // - When type is 'quote', this is the ID of the post doing the quoting
    // - When type is 'react', this is the ID of the post being reacted to
    postId: uuid("post_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    actorIds: uuid("actor_ids")
      .array()
      .$type<Uuid[]>()
      .notNull()
      .default(sql`(ARRAY[]::uuid[])`),
    emoji: text(),
    customEmojiId: uuid("custom_emoji_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => customEmojiTable.id, {
        onDelete: "cascade",
      }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index("idx_notification_account_id_created").on(
      table.accountId,
      desc(table.created),
    ),
    check(
      "notification_post_id_check",
      sql`
        CASE ${table.type}
          WHEN 'follow' THEN ${table.postId} IS NULL
          ELSE ${table.postId} IS NOT NULL
        END
      `,
    ),
    check(
      "notification_emoji_check",
      sql`
        CASE ${table.type}
          WHEN 'react'
          THEN ${table.emoji} IS NOT NULL AND ${table.customEmojiId} IS NULL
            OR ${table.emoji} IS NULL AND ${table.customEmojiId} IS NOT NULL
          ELSE ${table.emoji} IS NULL AND ${table.customEmojiId} IS NULL
        END
      `,
    ),
    uniqueIndex()
      .on(table.accountId, table.actorIds)
      .where(sql`${table.type} = 'follow'`),
    uniqueIndex()
      .on(table.accountId, table.postId)
      .where(sql`${table.type} NOT IN ('follow', 'react')`),
    uniqueIndex()
      .on(table.accountId, table.postId, table.emoji)
      .where(sql`${table.type} = 'react' AND ${table.customEmojiId} IS NULL`),
    uniqueIndex()
      .on(table.accountId, table.postId, table.customEmojiId)
      .where(sql`${table.type} = 'react' AND ${table.emoji} IS NULL`),
  ],
);

export type Notification = typeof notificationTable.$inferSelect;
export type NewNotification = typeof notificationTable.$inferInsert;

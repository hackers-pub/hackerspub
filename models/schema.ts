import { desc, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  bytea,
  check,
  doublePrecision,
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

export const POST_VISIBILITIES = [
  "public",
  "unlisted",
  "followers",
  "direct",
  "none",
] as const;

export const postVisibilityEnum = pgEnum("post_visibility", POST_VISIBILITIES);

export type PostVisibility = (typeof postVisibilityEnum.enumValues)[number];

export const quotePolicyEnum = pgEnum("quote_policy", [
  "everyone",
  "followers",
  "self",
]);

export type QuotePolicy = (typeof quotePolicyEnum.enumValues)[number];

export const pushNotificationPreviewPolicyEnum = pgEnum(
  "push_notification_preview_policy",
  [
    "public_only",
    "all",
    "none",
  ],
);

export type PushNotificationPreviewPolicy =
  (typeof pushNotificationPreviewPolicyEnum.enumValues)[number];

export const pushNotificationServiceEnum = pgEnum(
  "push_notification_service",
  [
    "apns",
    "fcm",
    "web_push",
  ],
);

export type PushNotificationService =
  (typeof pushNotificationServiceEnum.enumValues)[number];

export const accountTable = pgTable(
  "account",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    username: varchar({ length: 50 }).notNull().unique(),
    oldUsername: varchar("old_username", { length: 50 }),
    usernameChanged: timestamp("username_changed", { withTimezone: true }),
    name: varchar({ length: 50 }).notNull(),
    bio: text().notNull(),
    avatarMediumId: uuid("avatar_medium_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => mediumTable.id, { onDelete: "set null" }),
    ogImageKey: text("og_image_key").unique(),
    locales: varchar().array().$type<Locale>(),
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
    preferAiSummary: boolean("prefer_ai_summary")
      .notNull()
      .default(true),
    noteVisibility: postVisibilityEnum("note_visibility")
      .notNull()
      .default("public"),
    shareVisibility: postVisibilityEnum("share_visibility")
      .notNull()
      .default("public"),
    quotePolicy: quotePolicyEnum("quote_policy")
      .notNull()
      .default("everyone"),
    pushNotificationPreviewPolicy: pushNotificationPreviewPolicyEnum(
      "push_notification_preview_policy",
    )
      .notNull()
      .default("public_only"),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index("account_avatar_medium_id_idx").on(table.avatarMediumId),
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
  (table) => [
    index("idx_account_email_lower_email").on(sql`lower(${table.email})`),
  ],
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
      .$type<PasskeyTransport>(),
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

export const hashtagFollowingTable = pgTable(
  "hashtag_following",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    tag: text().notNull(),
    pinned: boolean().notNull().default(false),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.tag] }),
    index().on(table.tag, table.accountId),
  ],
);

export type HashtagFollowing = typeof hashtagFollowingTable.$inferSelect;
export type NewHashtagFollowing = typeof hashtagFollowingTable.$inferInsert;

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
    index().on(table.blockeeId),
    check(
      "blocking_blocker_blockee_check",
      sql`${table.blockerId} != ${table.blockeeId}`,
    ),
  ],
);

export type Blocking = typeof blockingTable.$inferSelect;
export type NewBlocking = typeof blockingTable.$inferInsert;

export const mutingTable = pgTable(
  "muting",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    muterId: uuid("muter_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    muteeId: uuid("mutee_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.muterId, table.muteeId),
    index().on(table.muteeId),
    check(
      "muting_muter_mutee_check",
      sql`${table.muterId} != ${table.muteeId}`,
    ),
  ],
);

export type Muting = typeof mutingTable.$inferSelect;
export type NewMuting = typeof mutingTable.$inferInsert;

export const relaySubscriptionTable = pgTable(
  "relay_subscription",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .unique()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    followIri: text("follow_iri").notNull().unique(),
    accepted: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
);

export type RelaySubscription = typeof relaySubscriptionTable.$inferSelect;
export type NewRelaySubscription = typeof relaySubscriptionTable.$inferInsert;

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
    allowLlmTranslation: boolean("allow_llm_translation")
      .notNull()
      .default(false),
    quotePolicy: quotePolicyEnum("quote_policy").notNull().default(
      "everyone",
    ),
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
    summary: text(),
    summaryStarted: timestamp("summary_started", { withTimezone: true }),
    summaryUnnecessary: boolean("summary_unnecessary")
      .notNull()
      .default(false),
    content: text().notNull(),
    ogImageKey: text("og_image_key").unique(),
    originalLanguage: varchar("original_language"),
    translatorId: uuid("translator_id")
      .$type<Uuid>()
      .references(() => accountTable.id, { onDelete: "set null" }),
    translationRequesterId: uuid("translation_requester_id")
      .$type<Uuid>()
      .references(() => accountTable.id, { onDelete: "set null" }),
    beingTranslated: boolean("being_translated").notNull().default(false),
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
    check(
      "article_content_being_translated_check",
      sql`NOT ${table.beingTranslated} OR (${table.originalLanguage} IS NOT NULL)`,
    ),
  ],
);

export type ArticleContent = typeof articleContentTable.$inferSelect;
export type NewArticleContent = typeof articleContentTable.$inferInsert;

export const noteSourceTable = pgTable("note_source", {
  id: uuid().$type<Uuid>().primaryKey(),
  accountId: uuid("account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accountTable.id, { onDelete: "cascade" }),
  visibility: postVisibilityEnum().notNull().default("public"),
  quotePolicy: quotePolicyEnum("quote_policy").notNull().default("everyone"),
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

export const mediumTypeEnum = pgEnum("medium_type", [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type MediumType = (typeof mediumTypeEnum.enumValues)[number];

export function isMediumType(value: unknown): value is MediumType {
  return mediumTypeEnum.enumValues.includes(value as MediumType);
}

export const mediumTable = pgTable(
  "medium",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    key: text().notNull().unique(),
    type: mediumTypeEnum().notNull(),
    contentHash: text("content_hash").unique(),
    width: integer(),
    height: integer(),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    check(
      "medium_width_height_check",
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

export type Medium = typeof mediumTable.$inferSelect;
export type NewMedium = typeof mediumTable.$inferInsert;

export const noteSourceMediumTable = pgTable(
  "note_source_medium",
  {
    sourceId: uuid("note_source_id")
      .$type<Uuid>()
      .notNull()
      .references(() => noteSourceTable.id, { onDelete: "cascade" }),
    index: smallint().notNull(),
    mediumId: uuid("medium_id")
      .$type<Uuid>()
      .notNull()
      .references(() => mediumTable.id, { onDelete: "restrict" }),
    alt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.index] }),
    index("note_source_medium_medium_id_idx").on(table.mediumId),
    check("note_source_medium_index_check", sql`${table.index} >= 0`),
  ],
);

export type NoteSourceMedium = typeof noteSourceMediumTable.$inferSelect;
export type NewNoteSourceMedium = typeof noteSourceMediumTable.$inferInsert;

export const postTypeEnum = pgEnum("post_type", [
  "Article",
  "Note",
  "Question",
]);

export type PostType = (typeof postTypeEnum.enumValues)[number];

export const quoteTargetStateEnum = pgEnum("quote_target_state", [
  "pending",
  "denied",
]);

export type QuoteTargetState = (typeof quoteTargetStateEnum.enumValues)[number];

export type Emoji = string; // TODO: use a better type

export const postTable = pgTable(
  "post",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    type: postTypeEnum().notNull(),
    visibility: postVisibilityEnum().notNull().default("unlisted"),
    quotePolicy: quotePolicyEnum("quote_policy").notNull().default(
      "everyone",
    ),
    quoteRequestPolicy: quotePolicyEnum("quote_request_policy"),
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
    quoteAuthorizationIri: text("quote_authorization_iri"),
    quoteTargetState: quoteTargetStateEnum("quote_target_state"),
    name: text(),
    summary: text(),
    contentHtml: text("content_html").notNull(),
    language: varchar(),
    tags: jsonb().$type<Record<string, string>>().notNull().default({}),
    relayedTags: text("relayed_tags").array().notNull().default(
      sql`(ARRAY[]::text[])`,
    ),
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
    index("idx_post_actor_id_published_ms")
      .on(
        table.actorId,
        sql`(${table.published}::timestamptz(3)) desc`,
        desc(table.id),
      )
      .where(isNull(table.sharedPostId)),
    index().on(table.replyTargetId),
    index("post_shared_post_id_index")
      .on(table.sharedPostId)
      .where(isNotNull(table.sharedPostId)),
    index("post_quoted_post_id_index")
      .on(table.quotedPostId)
      .where(isNotNull(table.quotedPostId)),
    index("post_quote_authorization_iri_index")
      .on(table.quoteAuthorizationIri)
      .where(isNotNull(table.quoteAuthorizationIri)),
    index("idx_post_note_source_published")
      .on(desc(table.published))
      .where(isNotNull(table.noteSourceId)),
    index("idx_post_article_source_published")
      .on(desc(table.published))
      .where(isNotNull(table.articleSourceId)),
    index("idx_post_public_local_published")
      .on(
        table.visibility,
        sql`${table.published}::timestamptz(3) desc`,
        desc(table.id),
        table.language,
      )
      .where(sql`
        ${table.replyTargetId} IS NULL
        AND (
          ${table.noteSourceId} IS NOT NULL
          OR ${table.articleSourceId} IS NOT NULL
          OR ${table.sharedPostId} IS NOT NULL
        )
      `),
    index("idx_post_public_top_level_published")
      .on(
        table.visibility,
        sql`${table.published}::timestamptz(3) desc`,
        desc(table.id),
        table.language,
      )
      .where(sql`${table.replyTargetId} IS NULL`),
    // Keyword search in models/search.ts uses `contentHtml ILIKE '%kw%'`,
    // and a leading-wildcard ILIKE bypasses any B-tree index. The pg_trgm
    // GIN index makes that pattern indexable; the migration also enables
    // the extension.
    index("idx_post_content_html_trgm")
      .using("gin", table.contentHtml.op("gin_trgm_ops")),
    // Hashtag search in models/search.ts uses the JSONB `?` operator
    // (key existence). Without a GIN index this causes a full table scan and
    // statement timeouts on large datasets.
    index("idx_post_tags_gin")
      .using("gin", table.tags),
    // Support the news-score recompute (models/news.ts) with partial indexes
    // over just the "sharing" posts (carry a link, publicly visible, an
    // original post rather than a boost). `*_link` drives the per-link
    // aggregation (look up a link's shares by id); `*_published` / `*_updated`
    // let the periodic active-link sweep range by recency instead of scanning
    // every sharing post. Created in production via CREATE INDEX CONCURRENTLY
    // ahead of the migration, whose CREATE INDEX IF NOT EXISTS is then a no-op.
    index("idx_post_news_share_link")
      .on(table.linkId, table.published)
      .where(sql`
        ${table.linkId} IS NOT NULL AND ${table.sharedPostId} IS NULL
          AND ${table.visibility} IN ('public', 'unlisted')
      `),
    index("idx_post_news_share_published")
      .on(table.published)
      .where(sql`
        ${table.linkId} IS NOT NULL AND ${table.sharedPostId} IS NULL
          AND ${table.visibility} IN ('public', 'unlisted')
      `),
    index("idx_post_news_share_updated")
      .on(table.updated)
      .where(sql`
        ${table.linkId} IS NOT NULL AND ${table.sharedPostId} IS NULL
          AND ${table.visibility} IN ('public', 'unlisted')
      `),
  ],
);

export type Post = typeof postTable.$inferSelect;
export type NewPost = typeof postTable.$inferInsert;

export const quoteAuthorizationTable = pgTable(
  "quote_authorization",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    quotePostIri: text("quote_post_iri").notNull(),
    quotePostId: uuid("quote_post_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "set null" }),
    quotedPostId: uuid("quoted_post_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    attributedActorId: uuid("attributed_actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actorTable.id, { onDelete: "cascade" }),
    revoked: boolean().notNull().default(false),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.quotePostIri),
    index().on(table.quotePostId),
    index().on(table.quotedPostId),
  ],
);

export type QuoteAuthorization = typeof quoteAuthorizationTable.$inferSelect;
export type NewQuoteAuthorization = typeof quoteAuthorizationTable.$inferInsert;

export const quoteRequestTable = pgTable(
  "quote_request",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    iri: text().notNull().unique(),
    quotePostId: uuid("quote_post_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    quotedPostId: uuid("quoted_post_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    accepted: timestamp({ withTimezone: true }),
    rejected: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.quotePostId),
    index().on(table.quotedPostId),
    check(
      "quote_request_terminal_state_check",
      sql`NOT (${table.accepted} IS NOT NULL AND ${table.rejected} IS NOT NULL)`,
    ),
  ],
);

export type QuoteRequest = typeof quoteRequestTable.$inferSelect;
export type NewQuoteRequest = typeof quoteRequestTable.$inferInsert;

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

export const bookmarkTable = pgTable(
  "bookmark",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountTable.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => postTable.id, { onDelete: "cascade" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.postId] }),
    index("idx_bookmark_account_created")
      .on(table.accountId, desc(table.created), desc(table.postId)),
    index().on(table.postId),
  ],
);

export type Bookmark = typeof bookmarkTable.$inferSelect;
export type NewBookmark = typeof bookmarkTable.$inferInsert;

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
    score: doublePrecision().notNull().default(0),
    weightedMass: doublePrecision("weighted_mass").notNull().default(0),
    recencyComponent: doublePrecision("recency_component").notNull().default(0),
    postCount: integer("post_count").notNull().default(0),
    firstSharedAt: timestamp("first_shared_at", { withTimezone: true }),
    latestActivityAt: timestamp("latest_activity_at", { withTimezone: true }),
    scoreUpdated: timestamp("score_updated", { withTimezone: true }),
    // Moderator-applied penalty subtracted from `score` to demote a link in the
    // feed.  Persisted across recomputes (the recompute reads and re-applies it).
    scorePenalty: doublePrecision("score_penalty").notNull().default(0),
    // Flat promotion bonus added to `score` because a moderator-curated
    // `news_preferred_sharer` shared this link (the largest such sharer's bonus).
    // Recomputed, not edited directly; suppressed to 0 while `scorePenalty > 0`
    // (an explicit demotion/bury overrides the promotion), so the popular score
    // always reconstructs as `log10(max(1, weightedMass)) + recencyComponent +
    // promotionBonus - scorePenalty`.
    promotionBonus: doublePrecision("promotion_bonus").notNull().default(0),
    // Set when the link's URL matches a `news_excluded_pattern`; excludes it
    // from the feed list (every sort order) while leaving its discussion page
    // reachable.  Recomputed from the patterns, not edited directly.
    excludedFromNews: boolean("excluded_from_news").notNull().default(false),
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
    // News feed sorts.  The partial predicate `latest_activity_at IS NOT NULL`
    // is the canonical "has at least one public, non-boost sharing post" flag,
    // so scraped-but-never-publicly-shared links stay out of every feed query.
    // Every index carries the `id DESC` tiebreaker so it fully covers the
    // `(sortKey, id)` keyset pagination order (scores tie at 0 before/between
    // batch runs, and `first_shared_at` timestamps can collide).
    index("idx_post_link_score")
      .on(desc(table.score), desc(table.id))
      .where(isNotNull(table.latestActivityAt)),
    index("idx_post_link_first_shared")
      .on(desc(table.firstSharedAt), desc(table.id))
      .where(isNotNull(table.latestActivityAt)),
    index("idx_post_link_weighted_mass")
      .on(desc(table.weightedMass), desc(table.id))
      .where(isNotNull(table.latestActivityAt)),
  ],
);

export type PostLink = typeof postLinkTable.$inferSelect;
export type NewPostLink = typeof postLinkTable.$inferInsert;

// Moderator-managed URL patterns; a link whose URL matches any of these is
// excluded from the News feed list.  Patterns are Web-standard `URLPattern`
// strings (e.g. `https://example.com/*`, `https://*.example.com/*`).
export const newsExcludedPatternTable = pgTable(
  "news_excluded_pattern",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    pattern: text().notNull().unique(),
    note: text(),
    creatorId: uuid("creator_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "set null" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.creatorId),
  ],
);

export type NewsExcludedPattern = typeof newsExcludedPatternTable.$inferSelect;
export type NewNewsExcludedPattern =
  typeof newsExcludedPatternTable.$inferInsert;

// Moderator-curated actors whose shares are favored in the News feed.  A
// preferred sharer does two things, applied when scores are recomputed:
//
//  1.  Whitelist: its shares qualify as news shares even when it is a bot
//      (`Service`/`Application`) actor, which are otherwise excluded.  This is
//      what lets a curated automated feed (e.g. a Hacker News reposter) surface
//      at all.
//  2.  Promotion: the link it shares gets a flat `bonus` added to its popular
//      score (the largest bonus wins when several preferred sharers share the
//      same link), unless a moderator penalty on the link overrides it.
export const newsPreferredSharerTable = pgTable(
  "news_preferred_sharer",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .unique()
      .references((): AnyPgColumn => actorTable.id, { onDelete: "cascade" }),
    // Flat amount added to the shared link's popular `score`.  In the score's
    // units one point is `NEWS_TAU_SECONDS` (~14h) of recency, so the presets in
    // `news.ts` are deliberately coarse; not a free-form dial.
    bonus: doublePrecision().notNull(),
    note: text(),
    creatorId: uuid("creator_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "set null" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.creatorId),
  ],
);

export type NewsPreferredSharer = typeof newsPreferredSharerTable.$inferSelect;
export type NewNewsPreferredSharer =
  typeof newsPreferredSharerTable.$inferInsert;

// A durable backlog of actors whose News links need rescoring, drained by the
// background worker.  Curating or un-curating a `news_preferred_sharer` can
// affect every link the actor has ever shared; recomputing them inline would
// blow past the request's statement timeout for a high-volume feed bot, so the
// add/remove mutations only enqueue here (one row per actor: the PK is the
// de-dup) and the worker drains it in chunks off the request path.  This is a
// thin interim queue; it can be replaced by Fedify's general task queue once
// that lands (fedify-dev/fedify#206).
export const newsRescoreQueueTable = pgTable("news_rescore_queue", {
  actorId: uuid("actor_id")
    .$type<Uuid>()
    .primaryKey()
    .references((): AnyPgColumn => actorTable.id, { onDelete: "cascade" }),
  enqueued: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  // Lease timestamp: set when a worker claims this actor, refreshed while it
  // processes, and cleared (the row deleted) on success.  `null` means
  // unclaimed; a claim older than the lease window is treated as abandoned (the
  // worker crashed) and may be reclaimed.  This is what serializes processing of
  // a given actor across the per-process `Deno.cron` drains.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  // Set by an enqueue that lands while a worker is already processing this actor
  // (the actor was re-added/removed mid-rescore).  The claim clears it; if it is
  // set again by the time processing finishes, the worker reopens the row for
  // another pass instead of deleting it, so links rescored before the change are
  // not left with stale state.
  dirty: boolean("dirty").notNull().default(false),
});

export type NewsRescoreQueueItem = typeof newsRescoreQueueTable.$inferSelect;
export type NewNewsRescoreQueueItem = typeof newsRescoreQueueTable.$inferInsert;

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
    // Lets the news-score sweep (models/news.ts) find reactions created since a
    // cutoff by an index range instead of scanning the whole table.
    index("idx_reaction_created").on(table.created),
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
    // Denormalized copy of the underlying post's `type`. For shares this is
    // the type of the SHARED post (the original content) — `post_id` always
    // points to the underlying post, not the share wrapper, so the type
    // matches the row a JOIN would resolve. Carried on `timeline_item` so
    // `personalTimeline(postType: …)` queries (e.g. /feed/articles) can use
    // a covering index instead of joining `post` and filtering after the
    // fact, which scales linearly in feed depth.
    postType: postTypeEnum("post_type").notNull(),
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
      .on(
        table.accountId,
        sql`(${table.added}::timestamptz(3)) desc`,
        desc(table.postId),
      ),
    index("idx_timeline_item_account_id_appended")
      .on(
        table.accountId,
        sql`(${table.appended}::timestamptz(3)) desc`,
        desc(table.postId),
      ),
    // Composite indexes for postType-filtered queries (e.g. /feed/articles,
    // /feed/without-shares with a postType filter). Cover the
    // (account_id, post_type) WHERE plus the (cursor)::timestamptz(3) DESC,
    // post_id DESC ORDER BY directly, so the planner can satisfy filtered
    // timeline reads without a post-join seq filter. Mirror the cast used
    // in the unfiltered _added/_appended indexes and in getPersonalTimeline's
    // ORDER BY (which keys on `appended` for the default and on `added` when
    // `withoutShares` is set).
    index("idx_timeline_item_account_id_post_type_appended")
      .on(
        table.accountId,
        table.postType,
        sql`(${table.appended}::timestamptz(3)) desc`,
        desc(table.postId),
      ),
    index("idx_timeline_item_account_id_post_type_added")
      .on(
        table.accountId,
        table.postType,
        sql`(${table.added}::timestamptz(3)) desc`,
        desc(table.postId),
      ),
    index("timeline_item_post_id_index").on(table.postId),
  ],
);

export type TimelineItem = typeof timelineItemTable.$inferSelect;
export type NewTimelineItem = typeof timelineItemTable.$inferInsert;

export const pushNotificationTargetTable = pgTable(
  "push_notification_target",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    service: pushNotificationServiceEnum().notNull(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "cascade" }),
    token: text(),
    endpoint: text(),
    p256dh: text(),
    auth: text(),
    expirationTime: timestamp("expiration_time", { withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.accountId),
    uniqueIndex("push_notification_target_service_token_unique")
      .on(table.service, table.token)
      .where(isNotNull(table.token)),
    uniqueIndex("push_notification_target_endpoint_unique")
      .on(table.endpoint)
      .where(isNotNull(table.endpoint)),
    check(
      "push_notification_target_shape_check",
      sql`
        CASE ${table.service}
          WHEN 'apns' THEN
            ${table.token} IS NOT NULL AND
            ${table.token} ~ '^[0-9a-f]{64}$' AND
            ${table.endpoint} IS NULL AND
            ${table.p256dh} IS NULL AND
            ${table.auth} IS NULL AND
            ${table.expirationTime} IS NULL
          WHEN 'fcm' THEN
            ${table.token} IS NOT NULL AND
            length(${table.token}) > 0 AND
            ${table.endpoint} IS NULL AND
            ${table.p256dh} IS NULL AND
            ${table.auth} IS NULL AND
            ${table.expirationTime} IS NULL
          WHEN 'web_push' THEN
            ${table.token} IS NULL AND
            ${table.endpoint} IS NOT NULL AND
            length(${table.endpoint}) > 0 AND
            ${table.p256dh} IS NOT NULL AND
            length(${table.p256dh}) > 0 AND
            ${table.auth} IS NOT NULL AND
            length(${table.auth}) > 0
        END
      `,
    ),
  ],
);

export type PushNotificationTarget =
  typeof pushNotificationTargetTable.$inferSelect;
export type NewPushNotificationTarget =
  typeof pushNotificationTargetTable.$inferInsert;

export const notificationTypeEnum = pgEnum("notification_type", [
  "follow",
  "mention",
  "reply",
  "share",
  "quote",
  "shared_post_updated",
  "quoted_post_updated",
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
    // - When type is 'shared_post_updated', this is the updated shared post
    // - When type is 'quoted_post_updated', this is the updated quoted post
    // - When type is 'react', this is the ID of the post being reacted to
    postId: uuid("post_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => postTable.id, { onDelete: "cascade" }),
    actorIds: uuid("actor_ids")
      .array()
      .$type<Uuid>()
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
    index("notification_post_id_index")
      .on(table.postId)
      .where(isNotNull(table.postId)),
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
      .on(table.accountId, table.type, table.postId)
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

export const invitationLinkTable = pgTable(
  "invitation_link",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    inviterId: uuid("inviter_id")
      .$type<Uuid>()
      .notNull()
      .references((): AnyPgColumn => accountTable.id, { onDelete: "cascade" }),
    invitationsLeft: smallint("invitations_left").notNull(),
    message: text("message"),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    expires: timestamp({ withTimezone: true }),
  },
);

export type InvitationLink = typeof invitationLinkTable.$inferSelect;
export type NewInvitationLink = typeof invitationLinkTable.$inferInsert;

export const articleDraftMediumTable = pgTable(
  "article_draft_medium",
  {
    articleDraftId: uuid("article_draft_id")
      .$type<Uuid>()
      .notNull()
      .references(() => articleDraftTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    mediumId: uuid("medium_id")
      .$type<Uuid>()
      .notNull()
      .references(() => mediumTable.id, { onDelete: "restrict" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.articleDraftId, table.key] }),
    index("article_draft_medium_medium_id_idx").on(table.mediumId),
  ],
);

export type ArticleDraftMedium = typeof articleDraftMediumTable.$inferSelect;
export type NewArticleDraftMedium = typeof articleDraftMediumTable.$inferInsert;

export const articleSourceMediumTable = pgTable(
  "article_source_medium",
  {
    articleSourceId: uuid("article_source_id")
      .$type<Uuid>()
      .notNull()
      .references(() => articleSourceTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    mediumId: uuid("medium_id")
      .$type<Uuid>()
      .notNull()
      .references(() => mediumTable.id, { onDelete: "restrict" }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.articleSourceId, table.key] }),
    index("article_source_medium_medium_id_idx").on(table.mediumId),
  ],
);

export type ArticleSourceMedium = typeof articleSourceMediumTable.$inferSelect;
export type NewArticleSourceMedium =
  typeof articleSourceMediumTable.$inferInsert;

export const adminStateTable = pgTable("admin_state", {
  key: text().primaryKey(),
  value: text().notNull(),
  updated: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type AdminState = typeof adminStateTable.$inferSelect;
export type NewAdminState = typeof adminStateTable.$inferInsert;

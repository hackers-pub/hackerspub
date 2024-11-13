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

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const accountTable = pgTable(
  "account",
  {
    id: uuid().primaryKey(),
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
    deleted: timestamp({ withTimezone: true }).default(currentTimestamp),
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
  }),
);

export const accountEmailTable = pgTable(
  "account_email",
  {
    email: text().notNull().primaryKey(),
    accountId: uuid("account_id").notNull().references(() => accountTable.id),
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
    accountId: uuid("account_id").notNull().references(() => accountTable.id),
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
    accountId: uuid("account_id").notNull().references(() => accountTable.id),
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
    id: uuid().primaryKey(),
    iri: text().notNull().unique(),
    type: actorTypeEnum().notNull(),
    username: text().notNull(),
    instanceHost: text("instance_host")
      .notNull()
      .references(() => instanceTable.host),
    accountId: uuid("account_id").unique().references(() => accountTable.id),
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
  ({ one }) => ({
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

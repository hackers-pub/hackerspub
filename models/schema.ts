import {
  boolean,
  check,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const accountTypeEnum = pgEnum("account_type", [
  "person",
  "organization",
]);

export type AccountType = (typeof accountTypeEnum.enumValues)[number];

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
  ({ many }) => ({
    emails: many(accountEmailTable),
    keys: many(accountKeyTable),
    links: many(accountLinkTable),
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

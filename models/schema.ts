import {
  boolean,
  check,
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

const timestamps = {
  updated: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  deleted: timestamp({ withTimezone: true }).default(currentTimestamp),
};

export const accountTypeEnum = pgEnum("account_type", [
  "person",
  "organization",
]);

export const accountTable = pgTable(
  "account",
  {
    id: uuid().primaryKey(),
    username: varchar({ length: 50 }).notNull().unique(),
    name: varchar({ length: 50 }).notNull(),
    bio: text().notNull(),
    ...timestamps,
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
    ...timestamps,
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

export const accountLinkTable = pgTable(
  "account_link",
  {
    accountId: uuid("account_id").notNull().references(() => accountTable.id),
    index: smallint().notNull(),
    name: varchar({ length: 50 }).notNull(),
    url: text().notNull(),
    handle: text(),
    verified: timestamp({ withTimezone: true }),
    ...timestamps,
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

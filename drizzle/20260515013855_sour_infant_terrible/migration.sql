-- Add post_type to timeline_item, install both directions of the
-- post.type <-> timeline_item.post_type sync triggers BEFORE backfilling, then
-- enforce NOT NULL.
--
-- drizzle-kit's migrate runner executes each statement-breakpoint-separated
-- statement in its own implicit transaction (it's not a single BEGIN/COMMIT
-- block, which is why an explicit LOCK TABLE errors with "no active SQL
-- transaction"). The order below closes the consistency window without
-- needing an explicit lock:
--
--  - The fill trigger on timeline_item is installed right after the column
--    is added, so any old-code addPostToTimeline INSERT/UPDATE that lands
--    after step 1 but before SET NOT NULL still gets a valid post_type from
--    the underlying post row instead of leaving NULL behind (which would
--    break the SET NOT NULL step) or being rejected by the new schema.
--  - The sync trigger on post is installed before the backfill, so any
--    concurrent UPDATE post SET type = ... propagates to
--    timeline_item.post_type whether or not the backfill has reached that
--    row yet.
--  - The backfill itself is guarded by post_type IS NULL. Under READ
--    COMMITTED, UPDATE ... FROM treats the joined post row as a snapshot
--    constant: without the guard, the SET expression could overwrite a
--    trigger-written value with a stale snapshot value. The guard ensures
--    that once either trigger has filled a row, the backfill leaves it.

ALTER TABLE "timeline_item" ADD COLUMN "post_type" "post_type";--> statement-breakpoint

-- Always derive timeline_item.post_type from the underlying post row, even
-- when the caller passed an explicit value. Two reasons:
--
--  1. Source of truth: post.type is authoritative; an app-supplied value can
--     drift if the post's type changes between the caller resolving it and
--     committing the timeline_item insert. Doing the lookup at write time
--     keeps the column in lockstep with post.type.
--  2. Race closure: SELECT ... FOR SHARE on the post row blocks a concurrent
--     UPDATE post SET type = ... until this transaction commits. Without
--     that, the AFTER UPDATE trigger on post can fire while this insert is
--     still uncommitted (so it can't see our row), letting us commit a
--     stale post_type.
--
-- Cost is one SELECT per affected timeline_item row, but the SHARE lock is
-- already held on subsequent calls within the same transaction, so batch
-- inserts (addPostToTimeline writes one row per follower of the same post)
-- only pay the lock-acquisition cost once.
CREATE FUNCTION "fill_timeline_item_post_type"() RETURNS TRIGGER AS $$
BEGIN
  SELECT "type" INTO NEW."post_type" FROM "post" WHERE "id" = NEW."post_id" FOR SHARE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Fire on INSERT and on UPDATE OF post_id (rare repointing). NOT on
-- UPDATE OF post_type, because the migration's backfill writes post_type;
-- if the trigger fired there it would take a SHARE lock on `post` from
-- inside the backfill, which can deadlock against a concurrent
-- `UPDATE post SET type = ...` (whose AFTER UPDATE trigger is in turn
-- trying to lock the same timeline_item rows). The post sync trigger plus
-- the IS NULL guard on the backfill already cover the post_type case.
CREATE TRIGGER "trg_fill_timeline_item_post_type"
  BEFORE INSERT OR UPDATE OF "post_id" ON "timeline_item"
  FOR EACH ROW
  EXECUTE FUNCTION "fill_timeline_item_post_type"();--> statement-breakpoint

-- Sync timeline_item.post_type whenever post.type changes. persistPost() can
-- update post.type on its iri-keyed upsert (re-fetched federated objects), and
-- we don't want stale denormalized rows masking ARTICLE/NOTE-filtered timelines
-- after a type change. Installed before the backfill so a concurrent update
-- racing with the backfill can't slip through unnoticed.
CREATE FUNCTION "sync_timeline_item_post_type"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."type" IS DISTINCT FROM OLD."type" THEN
    UPDATE "timeline_item" SET "post_type" = NEW."type" WHERE "post_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "trg_sync_timeline_item_post_type"
  AFTER UPDATE OF "type" ON "post"
  FOR EACH ROW
  EXECUTE FUNCTION "sync_timeline_item_post_type"();--> statement-breakpoint

-- Only fill rows the triggers have not already touched. Under READ COMMITTED,
-- UPDATE ... FROM treats the joined post row as a snapshot constant, so
-- without the IS NULL guard the SET expression could overwrite a newer
-- trigger-written value with the pre-snapshot value of post.type.
UPDATE "timeline_item" AS ti
SET "post_type" = p."type"
FROM "post" AS p
WHERE p."id" = ti."post_id" AND ti."post_type" IS NULL;--> statement-breakpoint

ALTER TABLE "timeline_item" ALTER COLUMN "post_type" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "idx_timeline_item_account_id_post_type_appended" ON "timeline_item" ("account_id","post_type",("appended"::timestamptz(3)) desc,"post_id" desc);--> statement-breakpoint
CREATE INDEX "idx_timeline_item_account_id_post_type_added" ON "timeline_item" ("account_id","post_type",("added"::timestamptz(3)) desc,"post_id" desc);

UPDATE "actor"
SET "published" = NULL
WHERE "actor"."published" < '1970-01-01 00:00:00';
UPDATE "actor"
SET "updated" = '1970-01-01 00:00:00'
WHERE "actor"."updated" < '1970-01-01 00:00:00';

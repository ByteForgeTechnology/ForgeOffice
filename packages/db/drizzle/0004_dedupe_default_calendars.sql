-- Merge duplicate default calendars / address books (created by a first-use race)
-- into the oldest copy before enforcing uniqueness.
UPDATE "calendars" c SET "sync_revision" = c."sync_revision" + 1000
WHERE c."id" IN (
  SELECT d.keep_id FROM (
    SELECT "id", first_value("id") OVER (PARTITION BY "owner_type", "owner_id" ORDER BY "created_at", "id") AS keep_id FROM "calendars" WHERE "is_default"
  ) d WHERE d."id" <> d.keep_id
);--> statement-breakpoint
UPDATE "calendar_objects" o SET "calendar_id" = d.keep_id, "sync_revision" = (SELECT k."sync_revision" FROM "calendars" k WHERE k."id" = d.keep_id)
FROM (
  SELECT "id", first_value("id") OVER (PARTITION BY "owner_type", "owner_id" ORDER BY "created_at", "id") AS keep_id FROM "calendars" WHERE "is_default"
) d
WHERE o."calendar_id" = d."id" AND d."id" <> d.keep_id
  AND NOT EXISTS (SELECT 1 FROM "calendar_objects" x WHERE x."calendar_id" = d.keep_id AND (x."href" = o."href" OR x."uid" = o."uid"));--> statement-breakpoint
DELETE FROM "calendars" c USING (
  SELECT "id", first_value("id") OVER (PARTITION BY "owner_type", "owner_id" ORDER BY "created_at", "id") AS keep_id FROM "calendars" WHERE "is_default"
) d WHERE c."id" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
UPDATE "address_books" b SET "sync_revision" = b."sync_revision" + 1000
WHERE b."id" IN (
  SELECT d.keep_id FROM (
    SELECT "id", first_value("id") OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS keep_id FROM "address_books" WHERE "is_default"
  ) d WHERE d."id" <> d.keep_id
);--> statement-breakpoint
UPDATE "contacts" o SET "address_book_id" = d.keep_id, "sync_revision" = (SELECT k."sync_revision" FROM "address_books" k WHERE k."id" = d.keep_id)
FROM (
  SELECT "id", first_value("id") OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS keep_id FROM "address_books" WHERE "is_default"
) d
WHERE o."address_book_id" = d."id" AND d."id" <> d.keep_id
  AND NOT EXISTS (SELECT 1 FROM "contacts" x WHERE x."address_book_id" = d.keep_id AND x."href" = o."href");--> statement-breakpoint
DELETE FROM "address_books" b USING (
  SELECT "id", first_value("id") OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS keep_id FROM "address_books" WHERE "is_default"
) d WHERE b."id" = d."id" AND d."id" <> d.keep_id;--> statement-breakpoint
CREATE UNIQUE INDEX "address_books_default_uq" ON "address_books" USING btree ("user_id") WHERE "address_books"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_default_uq" ON "calendars" USING btree ("owner_type","owner_id") WHERE "calendars"."is_default";
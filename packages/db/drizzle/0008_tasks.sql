DROP INDEX "calendars_default_uq";--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "kind" text DEFAULT 'events' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "role" text;--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_role_uq" ON "calendars" USING btree ("owner_type","owner_id","role") WHERE "calendars"."role" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_default_uq" ON "calendars" USING btree ("owner_type","owner_id","kind") WHERE "calendars"."is_default";